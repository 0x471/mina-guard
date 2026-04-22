import { Field, Mina, PrivateKey, PublicKey } from 'o1js';
import { MinaGuard } from '../MinaGuard.js';
import {
  setupLocalBlockchain,
  deployAndSetup,
  deployAndSetupChildGuard,
  proposeTransaction,
  approveTransaction,
  signSingleKeyDelegate,
  createDelegateProposal,
  type TestContext,
} from './test-helpers.js';
import { beforeEach, describe, expect, it } from 'bun:test';

/**
 * Parent/child-for-BPs end-to-end:
 *   - Parent = treasury reserve with optional delegation key.
 *   - Each child = dedicated delegation account pointed at a specific BP.
 * Validates the spec's M2-style multi-BP architecture while staying within
 * the M0 feature scope (one child per BP, CREATE_CHILD binds the initial
 * delegate into proposal.data so the parent's quorum approves the BP choice
 * atomically with the child spawn).
 */
describe('MinaGuard - Parent/Child for BPs', () => {
  let parentCtx: TestContext;
  let childKey: PrivateKey;
  let childAddress: PublicKey;
  let childZkApp: MinaGuard;
  const childDelegationKey = PrivateKey.random();

  beforeEach(async () => {
    parentCtx = await setupLocalBlockchain();
    await deployAndSetup(parentCtx, 2);

    childKey = PrivateKey.random();
    childAddress = childKey.toPublicKey();
    childZkApp = new MinaGuard(childAddress);
  });

  it('spawns a child guard that immediately delegates to the approved BP', async () => {
    const blockProducerA = PrivateKey.random().toPublicKey();

    const { proposalHash } = await deployAndSetupChildGuard(
      parentCtx,
      parentCtx.zkAppAddress,
      childZkApp,
      childKey,
      childAddress,
      parentCtx.owners.map((o) => o.pub),
      2,
      [0, 1, 2],
      Field(10),
      {
        childDelegationKey: childDelegationKey.toPublicKey(),
        childInitialDelegate: blockProducerA,
      },
    );

    expect(proposalHash).toBeDefined();
    expect(childZkApp.parent.get()).toEqual(parentCtx.zkAppAddress);
    // Child's stake is pointed at the BP approved by the parent's quorum.
    expect(childZkApp.account.delegate.get().equals(blockProducerA).toBoolean()).toBe(true);
    expect(childZkApp.delegationKeyHash.get().equals(Field(0)).toBoolean()).toBe(false);
    expect(childZkApp.delegationNonce.get()).toEqual(Field(0));
  });

  it('child rotates its delegation to a different BP via single-key', async () => {
    const blockProducerA = PrivateKey.random().toPublicKey();
    const blockProducerB = PrivateKey.random().toPublicKey();

    await deployAndSetupChildGuard(
      parentCtx,
      parentCtx.zkAppAddress,
      childZkApp,
      childKey,
      childAddress,
      parentCtx.owners.map((o) => o.pub),
      2,
      [0, 1, 2],
      Field(11),
      {
        childDelegationKey: childDelegationKey.toPublicKey(),
        childInitialDelegate: blockProducerA,
      },
    );

    // Rotate the child's delegation to BP-B using the child's own delegation key.
    const { signature, expiryBlock } = signSingleKeyDelegate({
      delegationKey: childDelegationKey,
      delegate: blockProducerB,
      guardAddress: childAddress,
      networkId: parentCtx.networkId,
      nonce: Field(0),
    });

    const rotateTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
      await childZkApp.executeDelegateSingleKey(
        blockProducerB,
        childDelegationKey.toPublicKey(),
        expiryBlock,
        signature,
      );
    });
    await rotateTxn.prove();
    await rotateTxn.sign([parentCtx.deployerKey]).send();

    expect(childZkApp.account.delegate.get().equals(blockProducerB).toBoolean()).toBe(true);
    expect(childZkApp.delegationNonce.get()).toEqual(Field(1));
  });

  it('multisig executeDelegate works as fallback if the delegation key is lost', async () => {
    const blockProducerA = PrivateKey.random().toPublicKey();
    const blockProducerC = PrivateKey.random().toPublicKey();

    await deployAndSetupChildGuard(
      parentCtx,
      parentCtx.zkAppAddress,
      childZkApp,
      childKey,
      childAddress,
      parentCtx.owners.map((o) => o.pub),
      2,
      [0, 1, 2],
      Field(12),
      {
        childDelegationKey: childDelegationKey.toPublicKey(),
        childInitialDelegate: blockProducerA,
      },
    );

    // Swap in the child context for multisig ops on the child.
    const childOwners = parentCtx.owners; // child reuses parent's owner set in this test
    const childCtx: TestContext = {
      ...parentCtx,
      zkApp: childZkApp,
      zkAppKey: childKey,
      zkAppAddress: childAddress,
      owners: childOwners,
      approvalStore: new (parentCtx.approvalStore.constructor as typeof parentCtx.approvalStore.constructor)(),
      nullifierStore: new (parentCtx.nullifierStore.constructor as typeof parentCtx.nullifierStore.constructor)(),
    };

    const proposal = createDelegateProposal(
      blockProducerC,
      Field(20),
      Field(0),
      childAddress,
      Field(0),
      parentCtx.networkId,
    );
    const proposalHash = await proposeTransaction(childCtx, proposal, 0);
    await approveTransaction(childCtx, proposal, 1);
    await approveTransaction(childCtx, proposal, 2);

    const approvalWitness = childCtx.approvalStore.getWitness(proposalHash);
    const execTxn = await Mina.transaction(parentCtx.deployerAccount, async () => {
      await childZkApp.executeDelegate(proposal, approvalWitness, Field(3));
    });
    await execTxn.prove();
    await execTxn.sign([parentCtx.deployerKey]).send();

    expect(childZkApp.account.delegate.get().equals(blockProducerC).toBoolean()).toBe(true);
    // Multisig path must not have touched the single-key nonce.
    expect(childZkApp.delegationNonce.get()).toEqual(Field(0));
  });
});
