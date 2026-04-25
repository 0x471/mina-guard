/**
 * Seeds the backend dev DB with realistic-looking M0 data so the UI renders
 * fully populated screens without needing any on-chain deploy. Used to take
 * walkthrough screenshots while the Auro+Mesa+sendTransaction gap blocks live
 * deploys on lightnet.
 *
 * Run from the backend workspace:
 *   bunx prisma db push --force-reset --skip-generate
 *   bun run scripts/seed-screenshots.ts
 *
 * The seeded data has no BlockHeader rows so the indexer's reorg detector
 * leaves it alone. ContractConfig snapshots use moderate validFromBlock
 * numbers below any real chain tip, so an indexer running against a fresh
 * lightnet will append above without touching seeded rows.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TREASURY_ADDR = 'B62qpj8xqP4ypKaFMDir1o6qEsr5bQTXVvku9pacinPgkQ6fR7MooNf';
const BP_CHILD_A_ADDR = 'B62qkH8fCV8WqYjDtNba2ov6ooRM5G4FiV587h24RcZzxdA5HrKZz14';
const BP_CHILD_B_ADDR = 'B62qqwcgbX2oaV8CyFbZfSZxwhj3e8mXd696cbnBduu9ZEWJcumU8jQ';

const OWNER_ALICE = 'B62qjMyM1ABizbC6nuc2MvJ752fjLAxU6qCAht5LnGninigYjN7aajB';
const OWNER_BOB = 'B62qpAGm2sH71JpPYn8nNVx3ozJZSwMiNpZxrNhaWi3oJoVRFFEh4Xp';
const OWNER_CARLA = 'B62qrPbGNxZHdXk8kqg9F3eqpbcvk4n1AKxeGCQzSgD2ePvVKRZ7Ti7';

const KRAKEN_ADDR = 'B62qq3TQ8AP7MFYPVtMx5tZGF3kWLJukfwG1A1RGvaBW1jfTPTkDBW6';
const COINBASE_ADDR = 'B62qoBwbo8DvK9CZc8KRNbukKLbKHZJq8h8pRLcoH9ChAzVvzhZmZkY';
const RANDO_DEPOSITOR = 'B62qrQ8RKmrpwM3cNhQfHRPbDygP4qDXfqbjjPnkfzGqkn4VwKzRiNd';

const BP_A_DELEGATE = 'B62qjAmKsjRtWcSi7t49E2RhxoRdwK4emJsh8nLbEH7sn3ARUTjLnPg';
const BP_B_DELEGATE = 'B62qrtxh6KBz4qYC2DVojB7mpD3wn9KhpYpKvTcaXmdsmgbavEZdaag';

const TREASURY_OWNERS_COMMITMENT = '23456789012345678901234567890123456789012345678901234567';
const ALLOWLIST_ROOT_WITH_TWO = '12345678901234567890123456789012345678901234567890123456';

async function clearAll(): Promise<void> {
  await prisma.approval.deleteMany();
  await prisma.proposalExecution.deleteMany();
  await prisma.proposalReceiver.deleteMany();
  await prisma.proposal.deleteMany();
  await prisma.singleKeyDelegation.deleteMany();
  await prisma.recipientAllowlistEntry.deleteMany();
  await prisma.recipientAlias.deleteMany();
  await prisma.incomingTransfer.deleteMany();
  await prisma.eventRaw.deleteMany();
  await prisma.ownerMembership.deleteMany();
  await prisma.contractConfig.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.indexerCursor.deleteMany();
  await prisma.blockHeader.deleteMany();
}

async function seed(): Promise<void> {
  await clearAll();

  await prisma.contract.createMany({
    data: [
      {
        address: TREASURY_ADDR,
        ready: true,
        discoveredAtBlock: 100,
        lastSyncedAt: new Date(),
        proposalCounter: 4,
      },
      {
        address: BP_CHILD_A_ADDR,
        parent: TREASURY_ADDR,
        ready: true,
        discoveredAtBlock: 110,
        lastSyncedAt: new Date(),
      },
      {
        address: BP_CHILD_B_ADDR,
        parent: TREASURY_ADDR,
        ready: true,
        discoveredAtBlock: 130,
        lastSyncedAt: new Date(),
      },
    ],
  });

  const treasury = await prisma.contract.findUniqueOrThrow({ where: { address: TREASURY_ADDR } });
  const childA = await prisma.contract.findUniqueOrThrow({ where: { address: BP_CHILD_A_ADDR } });
  const childB = await prisma.contract.findUniqueOrThrow({ where: { address: BP_CHILD_B_ADDR } });

  await prisma.contractConfig.createMany({
    data: [
      {
        contractId: treasury.id,
        validFromBlock: 100,
        threshold: 2,
        numOwners: 3,
        nonce: 2,
        parentNonce: 0,
        configNonce: 1,
        delegate: null,
        childMultiSigEnabled: true,
        ownersCommitment: TREASURY_OWNERS_COMMITMENT,
        networkId: '0',
        delegationKeyHash: null,
        delegationNonce: null,
        recipientAllowlistRoot: ALLOWLIST_ROOT_WITH_TWO,
        enforceRecipientAllowlist: true,
      },
      {
        contractId: childA.id,
        validFromBlock: 110,
        threshold: 2,
        numOwners: 3,
        nonce: 0,
        parentNonce: 0,
        configNonce: 0,
        delegate: BP_A_DELEGATE,
        childMultiSigEnabled: true,
        ownersCommitment: TREASURY_OWNERS_COMMITMENT,
        networkId: '0',
        delegationKeyHash: '99999999999999999999999999999999999999999999999999999999',
        delegationNonce: 1,
        recipientAllowlistRoot: null,
        enforceRecipientAllowlist: false,
      },
      {
        contractId: childB.id,
        validFromBlock: 130,
        threshold: 2,
        numOwners: 3,
        nonce: 0,
        parentNonce: 0,
        configNonce: 0,
        delegate: BP_B_DELEGATE,
        childMultiSigEnabled: true,
        ownersCommitment: TREASURY_OWNERS_COMMITMENT,
        networkId: '0',
        delegationKeyHash: '88888888888888888888888888888888888888888888888888888888',
        delegationNonce: 0,
        recipientAllowlistRoot: null,
        enforceRecipientAllowlist: false,
      },
    ],
  });

  // Owners — same set across all three guards (parent inheritance)
  for (const c of [treasury, childA, childB]) {
    await prisma.ownerMembership.createMany({
      data: [
        { contractId: c.id, address: OWNER_ALICE, action: 'added', index: 0, validFromBlock: c.discoveredAtBlock! },
        { contractId: c.id, address: OWNER_BOB, action: 'added', index: 1, validFromBlock: c.discoveredAtBlock! },
        { contractId: c.id, address: OWNER_CARLA, action: 'added', index: 2, validFromBlock: c.discoveredAtBlock! },
      ],
    });
  }

  // Recipient allowlist on the treasury (Kraken + Coinbase)
  await prisma.recipientAllowlistEntry.createMany({
    data: [
      { contractId: treasury.id, address: KRAKEN_ADDR, active: true, addedAt: new Date(Date.now() - 7 * 86400 * 1000) },
      { contractId: treasury.id, address: COINBASE_ADDR, active: true, addedAt: new Date(Date.now() - 5 * 86400 * 1000) },
    ],
  });

  // Address book aliases (UI-layer only)
  await prisma.recipientAlias.createMany({
    data: [
      { contractId: treasury.id, alias: 'Kraken hot wallet', address: KRAKEN_ADDR, createdBy: OWNER_ALICE },
      { contractId: treasury.id, alias: 'Coinbase Prime', address: COINBASE_ADDR, createdBy: OWNER_BOB },
    ],
  });

  // Single-key delegation history on Child A — one rotation already happened
  await prisma.singleKeyDelegation.createMany({
    data: [
      {
        contractId: childA.id,
        delegate: BP_A_DELEGATE,
        nonce: 0,
        blockHeight: 200,
        txHash: '5JtA9nfak3xBPHwMr8YzEp7ttKCdq2BKy3D1dtgZAGCHVdGCx7LU',
        createdAt: new Date(Date.now() - 3 * 86400 * 1000),
      },
    ],
  });

  // Inbound transfers — three deposits into the treasury at increasing heights
  await prisma.incomingTransfer.createMany({
    data: [
      {
        contractId: treasury.id,
        fromAddress: RANDO_DEPOSITOR,
        amount: '50000000000000', // 50,000 MINA in nanomina
        memo: 'Q1 funding tranche',
        blockHeight: 250,
        txHash: '5JtxRGq9PvLNGKW2v8B6vqkMZxZWRQjKLJpLLkqRgYQNvXWrJgxr',
        createdAt: new Date(Date.now() - 6 * 86400 * 1000),
      },
      {
        contractId: treasury.id,
        fromAddress: RANDO_DEPOSITOR,
        amount: '10000000000000',
        memo: null,
        blockHeight: 280,
        txHash: '5JuAaa1bQpYpRjKMz2VwXz3w8QJjMhNbDDWbqLkhTsN8BmtFNHLy',
        createdAt: new Date(Date.now() - 4 * 86400 * 1000),
      },
      {
        contractId: treasury.id,
        fromAddress: RANDO_DEPOSITOR,
        amount: '2500000000000',
        memo: 'rebate',
        blockHeight: 320,
        txHash: '5JuQRq8MKKjzXmtRnPXvD4yZjLJzWrBp5g3X9wmhJk8bN1LrTyXz',
        createdAt: new Date(Date.now() - 2 * 86400 * 1000),
      },
    ],
  });

  // Proposals across all four statuses
  // pending: created, 1 approval (proposer), expiry well in the future
  const pendingTransfer = await prisma.proposal.create({
    data: {
      contractId: treasury.id,
      proposalHash: 'PROP_PENDING_TRANSFER_001',
      proposer: OWNER_ALICE,
      toAddress: KRAKEN_ADDR,
      tokenId: '1',
      txType: 'transfer',
      data: '0',
      nonce: '3',
      configNonce: '1',
      expiryBlock: '99999',
      networkId: '0',
      guardAddress: TREASURY_ADDR,
      destination: 'local',
      childAccount: null,
      createdAtBlock: 350,
      memo: 'monthly OPEX',
      createTxHash: '5JtCreate1aZkQ8wRr2FkLpY6jTV7P8vJxqkYMrLLnD9DmkTNoXpY',
    },
  });
  await prisma.proposalReceiver.create({
    data: { proposalId: pendingTransfer.id, idx: 0, address: KRAKEN_ADDR, amount: '5000000000000' },
  });
  await prisma.approval.create({
    data: { proposalId: pendingTransfer.id, approver: OWNER_BOB, approvalRaw: 'sigB', blockHeight: 351 },
  });

  // executed: 2 approvals + ProposalExecution row
  const executedTransfer = await prisma.proposal.create({
    data: {
      contractId: treasury.id,
      proposalHash: 'PROP_EXECUTED_TRANSFER_002',
      proposer: OWNER_BOB,
      toAddress: COINBASE_ADDR,
      tokenId: '1',
      txType: 'transfer',
      data: '0',
      nonce: '1',
      configNonce: '0',
      expiryBlock: '99999',
      networkId: '0',
      guardAddress: TREASURY_ADDR,
      destination: 'local',
      childAccount: null,
      createdAtBlock: 200,
      memo: 'exchange rebalance',
      createTxHash: '5JtCreate2bZkQ8wRr2FkLpY6jTV7P8vJxqkYMrLLnD9DmkTNoXpY',
    },
  });
  await prisma.proposalReceiver.create({
    data: { proposalId: executedTransfer.id, idx: 0, address: COINBASE_ADDR, amount: '12000000000000' },
  });
  await prisma.approval.createMany({
    data: [
      { proposalId: executedTransfer.id, approver: OWNER_ALICE, approvalRaw: 'sigA', blockHeight: 201 },
      { proposalId: executedTransfer.id, approver: OWNER_CARLA, approvalRaw: 'sigC', blockHeight: 202 },
    ],
  });
  await prisma.proposalExecution.create({
    data: {
      proposalId: executedTransfer.id,
      blockHeight: 205,
      txHash: '5JtExec2bZmQ9xRs3GlMqZ7kUW8Q9wKyrlZNsMMoE0EnlUOpYqZ',
    },
  });

  // expired: expiryBlock far below "current" height (status code derives expired
  // when latestHeight > expiryBlock; the indexer in-memory chainHeight is what
  // the route reads — set IndexerCursor + accept that it'll show as pending if
  // no live indexer has populated chainHeight. Most relevant in screenshots is
  // having an EXPIRED-eligible row with a low expiry block; the UI also flags
  // it via the activity-feed expired filter regardless of in-memory cursor.)
  const expiredProposal = await prisma.proposal.create({
    data: {
      contractId: treasury.id,
      proposalHash: 'PROP_EXPIRED_ADD_OWNER_003',
      proposer: OWNER_CARLA,
      toAddress: 'B62qpAGm2sH71JpPYn8nNVx3ozJZSwMiNpZxrNhaWi3oJoVRFFEh4Xp',
      tokenId: '1',
      txType: 'addOwner',
      data: '0',
      nonce: '2',
      configNonce: '0',
      expiryBlock: '120',
      networkId: '0',
      guardAddress: TREASURY_ADDR,
      destination: 'local',
      childAccount: null,
      createdAtBlock: 50,
      memo: null,
      createTxHash: null,
    },
  });
  await prisma.approval.create({
    data: { proposalId: expiredProposal.id, approver: OWNER_ALICE, approvalRaw: 'sigA', blockHeight: 51 },
  });

  // invalidated: nonce stale relative to the current ContractConfig nonce
  // Treasury's latest ContractConfig.nonce is 2; this proposal sits at nonce
  // 1 with no execution, so deriveInvalidReason returns 'nonce-stale'.
  const invalidProposal = await prisma.proposal.create({
    data: {
      contractId: treasury.id,
      proposalHash: 'PROP_INVALID_TRANSFER_004',
      proposer: OWNER_ALICE,
      toAddress: KRAKEN_ADDR,
      tokenId: '1',
      txType: 'transfer',
      data: '0',
      nonce: '1',
      configNonce: '0',
      expiryBlock: '99999',
      networkId: '0',
      guardAddress: TREASURY_ADDR,
      destination: 'local',
      childAccount: null,
      createdAtBlock: 150,
      memo: null,
      createTxHash: null,
    },
  });
  await prisma.proposalReceiver.create({
    data: { proposalId: invalidProposal.id, idx: 0, address: KRAKEN_ADDR, amount: '8000000000000' },
  });

  // Index cursor — pretend the indexer has caught up. Actual live indexer
  // running against a fresh lightnet will set this back to its real position
  // on first tick, but seeded rows aren't tied to BlockHeaders so they survive.
  await prisma.indexerCursor.create({
    data: { key: 'indexer_height', value: '400' },
  });
  await prisma.indexerCursor.create({
    data: { key: 'incoming_height', value: '400' },
  });

  console.log('seeded:');
  console.log(`  3 contracts (1 treasury + 2 BP children)`);
  console.log(`  3 owner memberships per contract`);
  console.log(`  2 recipient allowlist entries (Kraken, Coinbase)`);
  console.log(`  2 recipient aliases (matching the allowlist)`);
  console.log(`  1 single-key delegation history row on child A`);
  console.log(`  3 inbound transfers (deposits into treasury)`);
  console.log(`  4 proposals: 1 pending, 1 executed, 1 expired, 1 invalidated`);
  console.log('');
  console.log(`treasury: ${TREASURY_ADDR}`);
  console.log(`owners:   alice=${OWNER_ALICE}`);
  console.log(`          bob=${OWNER_BOB}`);
  console.log(`          carla=${OWNER_CARLA}`);
  console.log('');
  console.log('connect with any of the three owner addresses in Auro on testnet');
  console.log('(or AUTH_DISABLED=true to bypass NextAuth) to view as that owner.');
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
