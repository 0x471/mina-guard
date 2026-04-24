import { AccountUpdate, Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { Receiver } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  buildRecipientAllowlistCheck,
  createTransferProposal,
  createAllocateChildProposal,
  createAddRecipientProposal,
  createRemoveRecipientProposal,
  fundAccount,
  getBalance,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

/**
 * `executeUpdateRecipientAllowlist` helper: proposes + approves a recipient
 * allowlist change then executes. Mirrors the standard governance propose →
 * approve → execute flow.
 */
async function applyRecipientChange(
  ctx: TestContext,
  proposal: ReturnType<typeof createAddRecipientProposal>,
): Promise<void> {
  const proposalHash = await proposeTransaction(ctx, proposal, 0);
  await approveTransaction(ctx, proposal, 1);
  await approveTransaction(ctx, proposal, 2);

  const approvalCount = ctx.approvalStore.getCount(proposalHash);
  const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
  const allowlistWitness = ctx.recipientAllowlistStore.getWitness(proposal.receivers[0].address);
  const currentValue = ctx.recipientAllowlistStore.getValue(proposal.receivers[0].address);

  const txn = await Mina.transaction(ctx.deployerAccount, async () => {
    await ctx.zkApp.executeUpdateRecipientAllowlist(
      proposal,
      approvalWitness,
      approvalCount,
      allowlistWitness,
      currentValue,
    );
  });
  await txn.prove();
  await txn.sign([ctx.deployerKey]).send();

  // Mirror the off-chain store.
  const isAdd = proposal.txType.toString() === '10';
  if (isAdd) {
    ctx.recipientAllowlistStore.add(proposal.receivers[0].address);
  } else {
    ctx.recipientAllowlistStore.remove(proposal.receivers[0].address);
  }
  ctx.approvalStore.setCount(proposalHash, Field(0).sub(1)); // EXECUTED_MARKER
}

describe('MinaGuard - Recipient Allowlist', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2, { enforceRecipientAllowlist: Field(1) });
  });

  it('adds a recipient via multisig proposal', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    const add = createAddRecipientProposal(recipient, Field(0), Field(0), ctx.zkAppAddress);
    await applyRecipientChange(ctx, add);

    expect(ctx.recipientAllowlistStore.isAllowed(recipient)).toBe(true);
    expect(ctx.zkApp.recipientAllowlistRoot.get()).toEqual(ctx.recipientAllowlistStore.getRoot());
  });

  it('removes a previously-added recipient', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await applyRecipientChange(
      ctx,
      createAddRecipientProposal(recipient, Field(0), Field(0), ctx.zkAppAddress),
    );

    await applyRecipientChange(
      ctx,
      createRemoveRecipientProposal(recipient, Field(1), Field(0), ctx.zkAppAddress),
    );

    expect(ctx.recipientAllowlistStore.isAllowed(recipient)).toBe(false);
    expect(ctx.zkApp.recipientAllowlistRoot.get()).toEqual(ctx.recipientAllowlistStore.getRoot());
  });

  it('rejects adding an already-allowed recipient (double-add)', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await applyRecipientChange(
      ctx,
      createAddRecipientProposal(recipient, Field(0), Field(0), ctx.zkAppAddress),
    );

    const again = createAddRecipientProposal(recipient, Field(1), Field(0), ctx.zkAppAddress);
    await expect(applyRecipientChange(ctx, again))
      .rejects.toThrow('Recipient allowlist entry in wrong state for this op');
  });

  it('rejects removing a non-member (remove-non-member)', async () => {
    const stranger = PrivateKey.random().toPublicKey();
    const remove = createRemoveRecipientProposal(stranger, Field(0), Field(0), ctx.zkAppAddress);
    await expect(applyRecipientChange(ctx, remove))
      .rejects.toThrow('Recipient allowlist entry in wrong state for this op');
  });

  it('enforces allowlist on executeTransfer — rejects non-member', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, recipient);

    // Recipient not in allowlist.
    const amount = UInt64.from(1_000_000_000);
    const transfer = createTransferProposal(
      [new Receiver({ address: recipient, amount })],
      Field(10),
      Field(0),
      ctx.zkAppAddress,
    );
    const hash = await proposeTransaction(ctx, transfer, 0);
    await approveTransaction(ctx, transfer, 1);
    await approveTransaction(ctx, transfer, 2);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(hash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(
          transfer,
          approvalWitness,
          Field(3),
          buildRecipientAllowlistCheck(transfer, ctx.recipientAllowlistStore, true),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Recipient not allowed');
  });

  it('allows executeTransfer to a recipient after multisig adds them', async () => {
    const recipientKey = PrivateKey.random();
    const recipient = recipientKey.toPublicKey();
    await fundAccount(ctx, recipient);

    // Approve the recipient first.
    await applyRecipientChange(
      ctx,
      createAddRecipientProposal(recipient, Field(0), Field(0), ctx.zkAppAddress),
    );

    const amount = UInt64.from(1_000_000_000);
    const transfer = createTransferProposal(
      [new Receiver({ address: recipient, amount })],
      Field(10),
      Field(0),
      ctx.zkAppAddress,
    );
    const hash = await proposeTransaction(ctx, transfer, 0);
    await approveTransaction(ctx, transfer, 1);
    await approveTransaction(ctx, transfer, 2);

    const before = getBalance(recipient);
    const approvalWitness = ctx.approvalStore.getWitness(hash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeTransfer(
        transfer,
        approvalWitness,
        Field(3),
        buildRecipientAllowlistCheck(transfer, ctx.recipientAllowlistStore, true),
      );
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(getBalance(recipient).sub(before)).toEqual(amount);
  });

  it('rejects multi-receiver transfer when allowlist enforcement is on', async () => {
    // Companion to the "slot 0 only" design note: when the guard is
    // enforcing the allowlist, slots 1..N-1 must be empty. Regression
    // guard in case a future refactor restores multi-slot receivers
    // without also restoring the multi-witness check.
    const recipientA = PrivateKey.random().toPublicKey();
    const recipientB = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, recipientA);
    await fundAccount(ctx, recipientB);
    await applyRecipientChange(
      ctx,
      createAddRecipientProposal(recipientA, Field(0), Field(0), ctx.zkAppAddress),
    );

    // Post-add, check on-chain configNonce (existing tests read 0 because
    // they use a single allowlist change; the contract's behavior here is
    // the source of truth, not our expectation).
    const currentNonce = ctx.zkApp.configNonce.get();

    const amount = UInt64.from(500_000_000);
    const transfer = createTransferProposal(
      [
        new Receiver({ address: recipientA, amount }),
        new Receiver({ address: recipientB, amount }),
      ],
      Field(21),
      currentNonce,
      ctx.zkAppAddress,
    );
    const hash = await proposeTransaction(ctx, transfer, 0);
    await approveTransaction(ctx, transfer, 1);
    await approveTransaction(ctx, transfer, 2);

    await expect(async () => {
      const approvalWitness = ctx.approvalStore.getWitness(hash);
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeTransfer(
          transfer,
          approvalWitness,
          Field(3),
          buildRecipientAllowlistCheck(transfer, ctx.recipientAllowlistStore, true),
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Allowlist-enforced transfer accepts only receivers[0]');
  });

  it('allocate-to-children bypasses recipient allowlist enforcement', async () => {
    // Build a fake child address (the target doesn't need to be a real guard
    // for this test — we only care the allowlist is not consulted).
    const childAddress = PrivateKey.random().toPublicKey();
    await fundAccount(ctx, childAddress);

    const allocate = createAllocateChildProposal(
      [new Receiver({ address: childAddress, amount: UInt64.from(500_000_000) })],
      Field(20),
      Field(0),
      ctx.zkAppAddress,
    );
    const hash = await proposeTransaction(ctx, allocate, 0);
    await approveTransaction(ctx, allocate, 1);
    await approveTransaction(ctx, allocate, 2);

    const before = getBalance(childAddress);
    const approvalWitness = ctx.approvalStore.getWitness(hash);
    const txn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeAllocateToChildren(allocate, approvalWitness, Field(3));
    });
    await txn.prove();
    await txn.sign([ctx.deployerKey]).send();

    expect(getBalance(childAddress).sub(before)).toEqual(UInt64.from(500_000_000));
  });

  it('emits recipientAllowlistChange event with correct payload', async () => {
    const recipient = PrivateKey.random().toPublicKey();
    await applyRecipientChange(
      ctx,
      createAddRecipientProposal(recipient, Field(0), Field(0), ctx.zkAppAddress),
    );

    const events = await ctx.zkApp.fetchEvents();
    const changes = events.filter((e) => e.type === 'recipientAllowlistChange');
    expect(changes.length).toBe(1);
    const payload = changes[0].event.data as unknown as {
      recipient: typeof recipient;
      added: Field;
      newRoot: Field;
    };
    expect(payload.recipient.equals(recipient).toBoolean()).toBe(true);
    expect(payload.added).toEqual(Field(1));
    expect(payload.newRoot).toEqual(ctx.recipientAllowlistStore.getRoot());
  });
});
