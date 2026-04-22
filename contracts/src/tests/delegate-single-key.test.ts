import {
  AccountUpdate,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Signature,
  UInt32,
  UInt64,
} from 'o1js';
import { MinaGuard, SetupOwnersInput } from '../MinaGuard.js';
import { EMPTY_MERKLE_MAP_ROOT } from '../constants.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  proposeTransaction,
  approveTransaction,
  createDelegateProposal,
  signSingleKeyDelegate,
  toFixedSetupOwners,
  type TestContext,
} from './test-helpers.js';
import { computeOwnerChain } from '../list-commitment.js';
import { beforeEach, describe, expect, it } from 'bun:test';

/**
 * Runs `executeDelegateSingleKey` inside a fresh Mina tx, signed by the
 * caller-supplied account. Thin wrapper so the individual test cases can
 * focus on their specific failure/happy-path shape.
 */
async function callSingleKeyDelegate(
  ctx: TestContext,
  params: {
    delegate: PublicKey;
    delegationKeyPriv: PrivateKey;
    delegationKeyPub?: PublicKey;
    nonce: Field;
    expiryBlock?: UInt32;
    guardAddressOverride?: PublicKey;
    networkIdOverride?: Field;
  },
): Promise<void> {
  const guardAddress = params.guardAddressOverride ?? ctx.zkAppAddress;
  const networkId = params.networkIdOverride ?? ctx.networkId;
  const delegationKeyPub =
    params.delegationKeyPub ?? params.delegationKeyPriv.toPublicKey();

  const { signature, expiryBlock } = signSingleKeyDelegate({
    delegationKey: params.delegationKeyPriv,
    delegate: params.delegate,
    guardAddress,
    networkId,
    nonce: params.nonce,
    expiryBlock: params.expiryBlock,
  });

  const txn = await Mina.transaction(ctx.deployerAccount, async () => {
    await ctx.zkApp.executeDelegateSingleKey(
      params.delegate,
      delegationKeyPub,
      expiryBlock,
      signature,
    );
  });
  await txn.prove();
  await txn.sign([ctx.deployerKey]).send();
}

describe('MinaGuard - Single-Key Delegate', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupLocalBlockchain();
    await deployAndSetup(ctx, 2);
  });

  it('delegates to a block producer with a valid single-key signature', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    await callSingleKeyDelegate(ctx, {
      delegate: blockProducer,
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(0),
    });

    expect(ctx.zkApp.account.delegate.get().equals(blockProducer).toBoolean()).toBe(true);
    expect(ctx.zkApp.delegationNonce.get()).toEqual(Field(1));

    const events = await ctx.zkApp.fetchEvents();
    const singleKeyEvents = events.filter((e) => e.type === 'singleKeyDelegate');
    expect(singleKeyEvents.length).toBe(1);
    const payload = singleKeyEvents[0].event.data as unknown as {
      delegate: PublicKey;
      nonce: Field;
    };
    expect(payload.delegate.equals(blockProducer).toBoolean()).toBe(true);
    expect(payload.nonce).toEqual(Field(0));
  });

  it('undelegates (sets delegate to self) when delegate is PublicKey.empty', async () => {
    // First delegate somewhere non-empty.
    const blockProducer = PrivateKey.random().toPublicKey();
    await callSingleKeyDelegate(ctx, {
      delegate: blockProducer,
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(0),
    });

    // Then undelegate. Nonce has advanced to 1.
    await callSingleKeyDelegate(ctx, {
      delegate: PublicKey.empty(),
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(1),
    });

    expect(ctx.zkApp.account.delegate.get().equals(ctx.zkAppAddress).toBoolean()).toBe(true);
    expect(ctx.zkApp.delegationNonce.get()).toEqual(Field(2));
  });

  it('rejects a replay of a previously-consumed signature (nonce moved on)', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    // First call consumes nonce 0.
    await callSingleKeyDelegate(ctx, {
      delegate: blockProducer,
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(0),
    });

    // Re-sending the same nonce=0 signature must fail. Re-sign deterministically
    // so we know we're replaying the exact message, then submit directly.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: ctx.delegationKey.key,
      delegate: blockProducer,
      guardAddress: ctx.zkAppAddress,
      networkId: ctx.networkId,
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateSingleKey(
          blockProducer,
          ctx.delegationKey.pub,
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Invalid delegation signature');
  });

  it('rejects when the supplied pubkey does not match the committed hash', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();
    const wrongKey = PrivateKey.random();

    // Sign with the wrong key and pass that wrong key at call time. The
    // commitment mismatch fires before signature verification.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: wrongKey,
      delegate: blockProducer,
      guardAddress: ctx.zkAppAddress,
      networkId: ctx.networkId,
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateSingleKey(
          blockProducer,
          wrongKey.toPublicKey(),
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Delegation key hash mismatch');
  });

  it('rejects when the pubkey matches but the signature message does not', async () => {
    const realBP = PrivateKey.random().toPublicKey();
    const spoofedBP = PrivateKey.random().toPublicKey();

    // Sign for realBP, but submit with spoofedBP as the delegate.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: ctx.delegationKey.key,
      delegate: realBP,
      guardAddress: ctx.zkAppAddress,
      networkId: ctx.networkId,
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateSingleKey(
          spoofedBP,
          ctx.delegationKey.pub,
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Invalid delegation signature');
  });

  it('rejects a signature bound to a sibling guard address (cross-guard replay)', async () => {
    // Deploy a second guard sharing the same delegation key.
    const guardBKey = PrivateKey.random();
    const guardBAddress = guardBKey.toPublicKey();
    const guardBApp = new MinaGuard(guardBAddress);

    const deployTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      AccountUpdate.fundNewAccount(ctx.deployerAccount);
      await guardBApp.deploy();
    });
    await deployTxn.prove();
    await deployTxn.sign([ctx.deployerKey, guardBKey]).send();

    const ownersCommitment = computeOwnerChain(ctx.owners.map((o) => o.pub));
    const setupOwners = toFixedSetupOwners(ctx.owners.map((o) => o.pub));
    const setupTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await guardBApp.setup(
        ownersCommitment,
        Field(2),
        Field(ctx.owners.length),
        ctx.networkId,
        new SetupOwnersInput({ owners: setupOwners }),
        ctx.delegationKey.pub, // same delegation key as ctx.zkApp
        EMPTY_MERKLE_MAP_ROOT,
        Field(0),
      );
    });
    await setupTxn.prove();
    await setupTxn.sign([ctx.deployerKey, guardBKey]).send();

    const blockProducer = PrivateKey.random().toPublicKey();

    // Sign with guard A's address, submit to guard B. Both guards accept the
    // same delegation-key commitment, but the guardAddress term in the message
    // prevents the signature from replaying.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: ctx.delegationKey.key,
      delegate: blockProducer,
      guardAddress: ctx.zkAppAddress, // guard A
      networkId: ctx.networkId,
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await guardBApp.executeDelegateSingleKey(
          blockProducer,
          ctx.delegationKey.pub,
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Invalid delegation signature');
  });

  it('rejects a signature bound to a different networkId (cross-network replay)', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    // Signature produced for a different networkId than the one stored on-chain.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: ctx.delegationKey.key,
      delegate: blockProducer,
      guardAddress: ctx.zkAppAddress,
      networkId: Field(999), // mismatched
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(ctx.deployerAccount, async () => {
        await ctx.zkApp.executeDelegateSingleKey(
          blockProducer,
          ctx.delegationKey.pub,
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([ctx.deployerKey]).send();
    }).toThrow('Invalid delegation signature');
  });

  it('rejects a signature whose expiryBlock is before the current block height', async () => {
    // Mina.LocalBlockchain exposes `setBlockchainLength` for tests. We push
    // the chain forward past a non-zero expiry so the expired-branch fires.
    // expiryBlock = 0 stays reserved for "no expiry" and is covered below.
    const local = Mina.activeInstance as unknown as {
      setBlockchainLength: (h: UInt32) => void;
    };
    local.setBlockchainLength(UInt32.from(100));

    const blockProducer = PrivateKey.random().toPublicKey();

    await expect(async () => {
      await callSingleKeyDelegate(ctx, {
        delegate: blockProducer,
        delegationKeyPriv: ctx.delegationKey.key,
        nonce: Field(0),
        expiryBlock: UInt32.from(50), // chain at 100, expiry at 50 -> expired
      });
    }).toThrow('Single-key delegation expired');
  });

  it('honors expiryBlock = 0 as "no expiry"', async () => {
    const blockProducer = PrivateKey.random().toPublicKey();

    await callSingleKeyDelegate(ctx, {
      delegate: blockProducer,
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(0),
      expiryBlock: UInt32.from(0),
    });

    expect(ctx.zkApp.account.delegate.get().equals(blockProducer).toBoolean()).toBe(true);
  });

  it('rejects when single-key delegation is disabled (delegationKeyHash = 0)', async () => {
    // Fresh context with delegation disabled at setup.
    const disabledCtx = await setupLocalBlockchain();
    await deployAndSetup(disabledCtx, 2, { delegationKey: PublicKey.empty() });

    expect(disabledCtx.zkApp.delegationKeyHash.get()).toEqual(Field(0));

    const blockProducer = PrivateKey.random().toPublicKey();

    // Any call, even with a "correct" pubkey/signature pair, must fail on
    // the disabled check, which runs before commitment matching so a probe
    // can't leak whether the guard is disabled vs. just configured differently.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: disabledCtx.delegationKey.key,
      delegate: blockProducer,
      guardAddress: disabledCtx.zkAppAddress,
      networkId: disabledCtx.networkId,
      nonce: Field(0),
    });

    await expect(async () => {
      const txn = await Mina.transaction(disabledCtx.deployerAccount, async () => {
        await disabledCtx.zkApp.executeDelegateSingleKey(
          blockProducer,
          disabledCtx.delegationKey.pub,
          expiryBlock,
          signature,
        );
      });
      await txn.prove();
      await txn.sign([disabledCtx.deployerKey]).send();
    }).toThrow('Single-key delegation not configured');
  });

  it('leaves approvalRoot and multisig delegation path unaffected', async () => {
    const approvalRootBefore = ctx.zkApp.approvalRoot.get();
    const configNonceBefore = ctx.zkApp.configNonce.get();

    // Single-key delegate once.
    const blockProducerA = PrivateKey.random().toPublicKey();
    await callSingleKeyDelegate(ctx, {
      delegate: blockProducerA,
      delegationKeyPriv: ctx.delegationKey.key,
      nonce: Field(0),
    });

    // Multisig path: approvalRoot may shift from propose/approve below,
    // but it must not have been touched by the single-key call.
    expect(ctx.zkApp.approvalRoot.get()).toEqual(approvalRootBefore);
    expect(ctx.zkApp.configNonce.get()).toEqual(configNonceBefore);

    // Now run a full multisig delegate to confirm the path still works.
    const blockProducerB = PrivateKey.random().toPublicKey();
    const proposal = createDelegateProposal(blockProducerB, Field(0), Field(0), ctx.zkAppAddress);
    const proposalHash = await proposeTransaction(ctx, proposal, 0);
    await approveTransaction(ctx, proposal, 1);
    await approveTransaction(ctx, proposal, 2);

    const approvalWitness = ctx.approvalStore.getWitness(proposalHash);
    const execTxn = await Mina.transaction(ctx.deployerAccount, async () => {
      await ctx.zkApp.executeDelegate(proposal, approvalWitness, Field(3));
    });
    await execTxn.prove();
    await execTxn.sign([ctx.deployerKey]).send();

    expect(ctx.zkApp.account.delegate.get().equals(blockProducerB).toBoolean()).toBe(true);

    // Multisig execution must not have touched the single-key nonce.
    expect(ctx.zkApp.delegationNonce.get()).toEqual(Field(1));
  });
});
