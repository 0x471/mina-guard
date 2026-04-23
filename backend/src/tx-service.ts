import {
  AccountUpdate,
  Cache,
  Field,
  Mina,
  PrivateKey,
  PublicKey,
  Signature,
  UInt32,
  UInt64,
  fetchAccount,
} from 'o1js';
import {
  MinaGuard,
  Receiver,
  TransactionProposal,
  SetupOwnersInput,
  RecipientAllowlistCheck,
  RecipientAllowlistStore,
  OwnerStore,
  ApprovalStore,
  VoteNullifierStore,
  PublicKeyOption,
  MAX_OWNERS,
  MAX_RECEIVERS,
  EMPTY_MERKLE_MAP_ROOT,
  EXECUTED_MARKER,
  PROPOSED_MARKER,
  Destination,
} from 'contracts';
import { Bool, MerkleMap } from 'o1js';
import type { BackendConfig } from './config.js';
import { prisma } from './db.js';

/**
 * Backend-side proving for MinaGuard. Moves the heavy `MinaGuard.compile()`
 * cost out of the browser so the UI can stay a thin signing client. The VK
 * is computed once on first request and cached in memory for the life of the
 * process.
 *
 * For lightnet / dev, fee payment is delegated to a funded account fetched
 * from the lightnet account manager. Devnet/mainnet operator-pays mode and
 * user-pays mode are Phase X follow-ups.
 */

let compileCache: { vk: unknown } | null = null;
let compilePromise: Promise<void> | null = null;

/**
 * Compiles MinaGuard once per process. Subsequent calls return the cached
 * verification key immediately.
 */
async function ensureCompiled(): Promise<void> {
  if (compileCache) return;
  if (!compilePromise) {
    compilePromise = (async () => {
      console.log('[tx-service] compiling MinaGuard (first-time, may take minutes)...');
      const start = Date.now();
      // o1js @2701 (pkg.pr.new) has a WASM bug in caml_pasta_fp_plonk_index_encode
      // that traps on step-proving-key serialization. We use a read-only
      // FileSystem cache so the SRS and any pre-existing keys are read from
      // disk, but writes are skipped — side-stepping the trap via the
      // canWrite guard in zkprogram.js write_().
      const cacheDir = './cache';
      const baseCache = Cache.FileSystem(cacheDir);
      const readOnlyCache = { ...baseCache, canWrite: false };
      try {
        const { verificationKey } = await MinaGuard.compile({
          cache: readOnlyCache,
        });
        compileCache = { vk: verificationKey };
        console.log(`[tx-service] MinaGuard compiled in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.error('[tx-service] compile failed:', e);
        throw e;
      }
    })();
  }
  await compilePromise;
}

/**
 * Acquires a funded account from the lightnet account manager. Only usable
 * on lightnet; devnet / mainnet need an operator key supplied via env.
 */
async function acquireLightnetFeePayer(config: BackendConfig): Promise<{
  pub: PublicKey;
  key: PrivateKey;
}> {
  if (!config.lightnetAccountManager) {
    throw new Error('LIGHTNET_ACCOUNT_MANAGER not configured — backend proving is lightnet-only right now');
  }
  const resp = await fetch(`${config.lightnetAccountManager}/acquire-account`);
  if (!resp.ok) {
    throw new Error(`Lightnet account manager returned ${resp.status}`);
  }
  const body = (await resp.json()) as { pk: string; sk: string };
  return {
    pub: PublicKey.fromBase58(body.pk),
    key: PrivateKey.fromBase58(body.sk),
  };
}

export interface DeployGuardInput {
  owners: string[];
  threshold: number;
  networkId: string;
  delegationKey?: string | null;
  recipientAllowlistRoot?: string | null;
  enforceRecipientAllowlist?: boolean;
}

export interface DeployGuardOutput {
  zkAppAddress: string;
  zkAppPrivateKey: string;
  txHash: string;
  feePayerAddress: string;
}

/**
 * Generates a fresh zkApp keypair, deploys MinaGuard at that address, and
 * runs `setup` in the same transaction. Returns the new address + its
 * private key (UI is responsible for persisting the private key securely —
 * needed later for `executeSetupChild` if the guard ever spawns children).
 */
export async function deployGuard(
  config: BackendConfig,
  input: DeployGuardInput,
): Promise<DeployGuardOutput> {
  if (input.threshold < 2) {
    throw new Error('Threshold must be >= 2 (separation of duties)');
  }
  if (input.owners.length < input.threshold) {
    throw new Error('Fewer owners than threshold — cannot ever reach quorum');
  }
  if (input.owners.length > MAX_OWNERS) {
    throw new Error(`Maximum ${MAX_OWNERS} owners allowed`);
  }

  await ensureCompiled();

  const feePayer = await acquireLightnetFeePayer(config);
  await fetchAccount({ publicKey: feePayer.pub });

  const zkAppKey = PrivateKey.random();
  const zkAppAddress = zkAppKey.toPublicKey();
  const zkApp = new MinaGuard(zkAppAddress);

  const ownerStore = new OwnerStore();
  const ownerKeys = input.owners.map((a) => PublicKey.fromBase58(a));
  for (const owner of ownerKeys) ownerStore.addSorted(owner);

  const paddedOwners = [...ownerStore.owners];
  while (paddedOwners.length < MAX_OWNERS) paddedOwners.push(PublicKey.empty());

  const delegationKey = input.delegationKey
    ? PublicKey.fromBase58(input.delegationKey)
    : PublicKey.empty();
  const allowlistRoot = input.recipientAllowlistRoot
    ? Field(input.recipientAllowlistRoot)
    : EMPTY_MERKLE_MAP_ROOT;
  const enforceAllowlist = input.enforceRecipientAllowlist ? Field(1) : Field(0);

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      AccountUpdate.fundNewAccount(feePayer.pub);
      await zkApp.deploy();
      await zkApp.setup(
        ownerStore.getCommitment(),
        Field(input.threshold),
        Field(ownerKeys.length),
        Field(input.networkId),
        new SetupOwnersInput({ owners: paddedOwners.slice(0, MAX_OWNERS) }),
        delegationKey,
        allowlistRoot,
        enforceAllowlist,
      );
    },
  );

  console.log('[tx-service] proving deploy+setup...');
  const proveStart = Date.now();
  await tx.prove();
  console.log(`[tx-service] proved in ${((Date.now() - proveStart) / 1000).toFixed(1)}s`);

  const pending = await tx.sign([feePayer.key, zkAppKey]).send();
  if (pending.status !== 'pending') {
    const errors = (pending as { errors?: unknown[] }).errors ?? [];
    throw new Error(`Submission rejected: ${JSON.stringify(errors)}`);
  }

  return {
    zkAppAddress: zkAppAddress.toBase58(),
    zkAppPrivateKey: zkAppKey.toBase58(),
    txHash: pending.hash,
    feePayerAddress: feePayer.pub.toBase58(),
  };
}

export interface DelegateSingleKeyInput {
  guardAddress: string;
  delegate: string | null; // null/empty → undelegate to self
  delegationKeyPub: string;
  expiryBlock: string | null; // UInt32 string, null/0 = no expiry
  signatureBase58: string; // Auro's `signFields` base58 signature over the canonical 7-field message
}

export interface DelegateSingleKeyOutput {
  txHash: string;
  feePayerAddress: string;
}

/**
 * Backend-proving `executeDelegateSingleKey`. UI collects the user's Auro
 * signature over the canonical 7-field message
 *   [...delegate.toFields(), ...guardAddress.toFields(), networkId, nonce, expiryBlock.value]
 * and POSTs it here. Backend reads on-chain state, builds + proves + submits.
 *
 * Signature verification still happens on-chain — the backend cannot forge
 * the user's signature, only relay it.
 */
export async function delegateSingleKey(
  config: BackendConfig,
  input: DelegateSingleKeyInput,
): Promise<DelegateSingleKeyOutput> {
  console.log('[tx-service] delegateSingleKey input:', {
    guardAddress: input.guardAddress,
    delegate: input.delegate,
    delegationKeyPub: input.delegationKeyPub,
    expiryBlockRaw: input.expiryBlock,
  });
  await ensureCompiled();

  const guardAddress = PublicKey.fromBase58(input.guardAddress);
  const delegationKeyPub = PublicKey.fromBase58(input.delegationKeyPub);
  const delegatePk = input.delegate ? PublicKey.fromBase58(input.delegate) : PublicKey.empty();
  const expiryBlock = UInt32.from(input.expiryBlock ?? '0');
  const signature = Signature.fromBase58(input.signatureBase58);
  console.log(`[tx-service] resolved expiryBlock=${expiryBlock.toString()} delegate=${delegatePk.toBase58()}`);

  const feePayer = await acquireLightnetFeePayer(config);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });

  const zkApp = new MinaGuard(guardAddress);

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeDelegateSingleKey(
        delegatePk,
        delegationKeyPub,
        expiryBlock,
        signature,
      );
    },
  );

  console.log('[tx-service] proving delegateSingleKey...');
  const start = Date.now();
  await tx.prove();
  console.log(`[tx-service] proved in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') {
    const errors = (pending as { errors?: unknown[] }).errors ?? [];
    throw new Error(`Submission rejected: ${JSON.stringify(errors)}`);
  }

  return {
    txHash: pending.hash,
    feePayerAddress: feePayer.pub.toBase58(),
  };
}

// ---------------------------------------------------------------------------
// LOCAL execute* methods via backend prover (owner / threshold / delegate /
// allocate / recipient-allowlist-update) and REMOTE child-lifecycle methods
// (reclaim / destroy / enable-child-multi-sig).
// ---------------------------------------------------------------------------

export async function executeOwnerChangeBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { ownerStore, approvalStore } = await rebuildStores(input.proposal.guardAddress);
  const proposalHash = proposal.hash();
  const target = proposal.receivers[0].address;
  const pred = ownerStore.sortedPredecessor(target);
  const insertAfter = pred
    ? new PublicKeyOption({ value: pred, isSome: Bool(true) })
    : PublicKeyOption.none();
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeOwnerChange(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalStore.getCount(proposalHash),
        ownerStore.getWitness(),
        insertAfter,
      );
    },
  );
  console.log('[tx-service] proving executeOwnerChange...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeThresholdChangeBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { approvalStore } = await rebuildStores(input.proposal.guardAddress);
  const proposalHash = proposal.hash();
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeThresholdChange(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalStore.getCount(proposalHash),
        Field(input.proposal.data),
      );
    },
  );
  console.log('[tx-service] proving executeThresholdChange...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeDelegateBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { approvalStore } = await rebuildStores(input.proposal.guardAddress);
  const proposalHash = proposal.hash();
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeDelegate(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalStore.getCount(proposalHash),
      );
    },
  );
  console.log('[tx-service] proving executeDelegate (multisig)...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeAllocateToChildrenBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { approvalStore } = await rebuildStores(input.proposal.guardAddress);
  const proposalHash = proposal.hash();
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeAllocateToChildren(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalStore.getCount(proposalHash),
      );
    },
  );
  console.log('[tx-service] proving executeAllocateToChildren...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeUpdateRecipientAllowlistBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { approvalStore, recipientAllowlistStore } = await rebuildStores(input.proposal.guardAddress);
  const proposalHash = proposal.hash();
  const recipient = proposal.receivers[0].address;
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.executeUpdateRecipientAllowlist(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalStore.getCount(proposalHash),
        recipientAllowlistStore.getWitness(recipient),
        recipientAllowlistStore.getValue(recipient),
      );
    },
  );
  console.log('[tx-service] proving executeUpdateRecipientAllowlist...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

/**
 * REMOTE child-lifecycle executes run on the CHILD guard, reading parent's
 * approval state cross-contract. Backend pulls the parent's approval
 * witness + the child's childExecutionRoot map.
 */
export async function executeReclaimToParentBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput; childAddress: string },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const parentAddress = input.proposal.guardAddress;
  const { approvalStore: parentApprovalStore } = await rebuildStores(parentAddress);
  const childExecMap = await rebuildChildExecutionMap(input.childAddress);
  const proposalHash = proposal.hash();
  const amount = UInt64.from(input.proposal.data);
  const feePayer = await acquireLightnetFeePayer(config);
  const childPk = PublicKey.fromBase58(input.childAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: PublicKey.fromBase58(parentAddress) });
  await fetchAccount({ publicKey: childPk });
  const childApp = new MinaGuard(childPk);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await childApp.executeReclaimToParent(
        proposal,
        parentApprovalStore.getWitness(proposalHash),
        parentApprovalStore.getCount(proposalHash),
        childExecMap.getWitness(proposalHash),
        amount,
      );
    },
  );
  console.log('[tx-service] proving executeReclaimToParent...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeDestroyBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput; childAddress: string },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const parentAddress = input.proposal.guardAddress;
  const { approvalStore: parentApprovalStore } = await rebuildStores(parentAddress);
  const childExecMap = await rebuildChildExecutionMap(input.childAddress);
  const proposalHash = proposal.hash();
  const feePayer = await acquireLightnetFeePayer(config);
  const childPk = PublicKey.fromBase58(input.childAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: PublicKey.fromBase58(parentAddress) });
  await fetchAccount({ publicKey: childPk });
  const childApp = new MinaGuard(childPk);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await childApp.executeDestroy(
        proposal,
        parentApprovalStore.getWitness(proposalHash),
        parentApprovalStore.getCount(proposalHash),
        childExecMap.getWitness(proposalHash),
      );
    },
  );
  console.log('[tx-service] proving executeDestroy...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

export async function executeEnableChildMultiSigBackend(
  config: BackendConfig,
  input: { proposal: ProposalInput; childAddress: string; enabled: boolean },
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const parentAddress = input.proposal.guardAddress;
  const { approvalStore: parentApprovalStore } = await rebuildStores(parentAddress);
  const childExecMap = await rebuildChildExecutionMap(input.childAddress);
  const proposalHash = proposal.hash();
  const enabledField = input.enabled ? Field(1) : Field(0);
  const feePayer = await acquireLightnetFeePayer(config);
  const childPk = PublicKey.fromBase58(input.childAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: PublicKey.fromBase58(parentAddress) });
  await fetchAccount({ publicKey: childPk });
  const childApp = new MinaGuard(childPk);
  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await childApp.executeEnableChildMultiSig(
        proposal,
        parentApprovalStore.getWitness(proposalHash),
        parentApprovalStore.getCount(proposalHash),
        childExecMap.getWitness(proposalHash),
        enabledField,
      );
    },
  );
  console.log('[tx-service] proving executeEnableChildMultiSig...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  return { txHash: pending.hash };
}

// ---------------------------------------------------------------------------
// Multisig: propose / approve / executeTransfer via backend prover.
// The user's Auro signs the proposalHash (one Field — Ledger-compatible).
// Backend reads EventRaw rows from Prisma to rebuild the off-chain stores,
// constructs + proves + submits. Only executeTransfer is covered here in
// this slice; other execute* variants can follow the same pattern.
// ---------------------------------------------------------------------------

interface ReceiverInput { address: string; amount: string }

export interface ProposalInput {
  receivers: ReceiverInput[];
  tokenId: string;
  txType: string;        // Field value as decimal string ("0"=TRANSFER, etc)
  data: string;
  uid: string;
  configNonce: string;
  expiryBlock: string;
  networkId: string;
  guardAddress: string;
  destination: string;   // "0" local, "1" remote
  childAccount: string;  // base58 or empty
}

function buildProposalStruct(input: ProposalInput): TransactionProposal {
  const receivers: InstanceType<typeof Receiver>[] = [];
  for (let i = 0; i < MAX_RECEIVERS; i++) {
    const r = input.receivers[i];
    if (r && r.address && r.address !== PublicKey.empty().toBase58()) {
      receivers.push(
        new Receiver({
          address: PublicKey.fromBase58(r.address),
          amount: UInt64.from(r.amount || '0'),
        }),
      );
    } else {
      receivers.push(Receiver.empty());
    }
  }
  return new TransactionProposal({
    receivers,
    tokenId: Field(input.tokenId),
    txType: Field(input.txType),
    data: Field(input.data),
    uid: Field(input.uid),
    configNonce: Field(input.configNonce),
    expiryBlock: Field(input.expiryBlock),
    networkId: Field(input.networkId),
    guardAddress: PublicKey.fromBase58(input.guardAddress),
    destination: Field(input.destination),
    childAccount: input.childAccount && input.childAccount !== PublicKey.empty().toBase58()
      ? PublicKey.fromBase58(input.childAccount)
      : PublicKey.empty(),
  });
}

/**
 * Replays the contract's EventRaw rows to reconstruct the off-chain stores
 * (owners / approvals / vote nullifiers). Mirrors the UI worker's
 * `rebuildStoresFromBackend` but talks to Prisma directly.
 */
async function rebuildStores(contractAddress: string): Promise<{
  ownerStore: OwnerStore;
  approvalStore: ApprovalStore;
  nullifierStore: VoteNullifierStore;
  recipientAllowlistStore: RecipientAllowlistStore;
}> {
  const ownerStore = new OwnerStore();
  const approvalStore = new ApprovalStore();
  const nullifierStore = new VoteNullifierStore();
  const recipientAllowlistStore = new RecipientAllowlistStore();

  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  if (!contract) throw new Error(`Contract ${contractAddress} not indexed`);

  const events = await prisma.eventRaw.findMany({
    where: { contractId: contract.id },
    orderBy: { blockHeight: 'asc' },
  });

  const emptyKey = PublicKey.empty().toBase58();
  const setupOwners = events
    .filter((e) => e.eventType === 'setupOwner')
    .map((e) => {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      return typeof p.owner === 'string' ? p.owner : null;
    })
    .filter((o): o is string => !!o && o.length > 10 && o !== emptyKey)
    .sort();
  for (const o of setupOwners) ownerStore.addSorted(PublicKey.fromBase58(o));

  for (const event of events) {
    const p = JSON.parse(event.payload) as Record<string, unknown>;
    if (event.eventType === 'ownerChange') {
      const owner = p.owner;
      const added = p.added;
      if (typeof owner === 'string' && owner.length > 10) {
        if (added === '1' || added === 1) ownerStore.addSorted(PublicKey.fromBase58(owner));
        else ownerStore.remove(PublicKey.fromBase58(owner));
      }
      continue;
    }
    if (event.eventType === 'proposal') {
      const hash = p.proposalHash;
      const proposer = p.proposer;
      if (typeof hash === 'string') {
        approvalStore.setCount(Field(hash), PROPOSED_MARKER);
      }
      if (typeof hash === 'string' && typeof proposer === 'string' && proposer.length > 10) {
        nullifierStore.nullify(Field(hash), PublicKey.fromBase58(proposer));
      }
      continue;
    }
    if (event.eventType === 'approval') {
      const hash = p.proposalHash;
      const approver = p.approver;
      const count = p.approvalCount;
      if (typeof hash === 'string' && typeof count === 'string') {
        approvalStore.setCount(Field(hash), Field(count));
      }
      if (typeof hash === 'string' && typeof approver === 'string' && approver.length > 10) {
        nullifierStore.nullify(Field(hash), PublicKey.fromBase58(approver));
      }
      continue;
    }
    if (event.eventType === 'execution') {
      const hash = p.proposalHash;
      const txType = p.txType;
      const isRemote = typeof txType === 'string' && (txType === '5' || txType === '7' || txType === '8' || txType === '9');
      if (typeof hash === 'string' && !isRemote) {
        approvalStore.setCount(Field(hash), EXECUTED_MARKER);
      }
      continue;
    }
    if (event.eventType === 'recipientAllowlistChange') {
      const recipient = p.recipient;
      const added = p.added;
      if (typeof recipient === 'string' && recipient.length > 10) {
        if (added === '1' || added === 1) recipientAllowlistStore.add(PublicKey.fromBase58(recipient));
        else recipientAllowlistStore.remove(PublicKey.fromBase58(recipient));
      }
      continue;
    }
  }

  return { ownerStore, approvalStore, nullifierStore, recipientAllowlistStore };
}

export interface ProposeBackendInput {
  proposal: ProposalInput;
  proposer: string;
  signatureBase58: string;
  memo?: string;
}

export async function proposeBackend(
  config: BackendConfig,
  input: ProposeBackendInput,
): Promise<{ txHash: string; proposalHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const proposerPk = PublicKey.fromBase58(input.proposer);
  const signature = Signature.fromBase58(input.signatureBase58);

  const { ownerStore, approvalStore, nullifierStore } = await rebuildStores(
    input.proposal.guardAddress,
  );

  const proposalHash = proposal.hash();
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);

  const tx = await Mina.transaction(
    {
      sender: feePayer.pub,
      fee: UInt64.from(100_000_000),
      memo: input.memo ?? '',
    },
    async () => {
      await zkApp.propose(
        proposal,
        ownerStore.getWitness(),
        proposerPk,
        signature,
        nullifierStore.getWitness(proposalHash, proposerPk),
        approvalStore.getWitness(proposalHash),
      );
    },
  );
  console.log('[tx-service] proving propose...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') {
    throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  }
  return { txHash: pending.hash, proposalHash: proposalHash.toString() };
}

export interface ApproveBackendInput {
  proposal: ProposalInput;
  approver: string;
  signatureBase58: string;
}

export async function approveBackend(
  config: BackendConfig,
  input: ApproveBackendInput,
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const approverPk = PublicKey.fromBase58(input.approver);
  const signature = Signature.fromBase58(input.signatureBase58);

  const { ownerStore, approvalStore, nullifierStore } = await rebuildStores(
    input.proposal.guardAddress,
  );

  const proposalHash = proposal.hash();
  const currentCount = approvalStore.getCount(proposalHash);
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000) },
    async () => {
      await zkApp.approveProposal(
        proposal,
        signature,
        approverPk,
        ownerStore.getWitness(),
        approvalStore.getWitness(proposalHash),
        currentCount,
        nullifierStore.getWitness(proposalHash, approverPk),
      );
    },
  );
  console.log('[tx-service] proving approve...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') {
    throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  }
  return { txHash: pending.hash };
}

/**
 * Rebuilds the `childExecutionRoot` MerkleMap for a child guard from its
 * indexed REMOTE execution events. Used by executeReclaim/Destroy/EnableChildMultiSig.
 */
async function rebuildChildExecutionMap(childAddress: string): Promise<MerkleMap> {
  const map = new MerkleMap();
  const child = await prisma.contract.findUnique({ where: { address: childAddress } });
  if (!child) return map;
  const events = await prisma.eventRaw.findMany({
    where: { contractId: child.id, eventType: 'execution' },
    orderBy: { blockHeight: 'asc' },
  });
  for (const e of events) {
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    const txType = p.txType;
    const hash = p.proposalHash;
    const isRemote = typeof txType === 'string' && (txType === '7' || txType === '8' || txType === '9');
    if (isRemote && typeof hash === 'string') {
      map.set(Field(hash), EXECUTED_MARKER);
    }
  }
  return map;
}

export interface ExecuteTransferBackendInput {
  proposal: ProposalInput;
}

export async function executeTransferBackend(
  config: BackendConfig,
  input: ExecuteTransferBackendInput,
): Promise<{ txHash: string }> {
  await ensureCompiled();
  const proposal = buildProposalStruct(input.proposal);
  const { approvalStore, recipientAllowlistStore } = await rebuildStores(
    input.proposal.guardAddress,
  );

  const proposalHash = proposal.hash();
  const approvalCount = approvalStore.getCount(proposalHash);
  const feePayer = await acquireLightnetFeePayer(config);
  const guardAddress = PublicKey.fromBase58(input.proposal.guardAddress);
  await fetchAccount({ publicKey: feePayer.pub });
  await fetchAccount({ publicKey: guardAddress });
  const zkApp = new MinaGuard(guardAddress);

  // Build the recipient-allowlist witness for slot 0 (the only slot
  // enforced under our shrunk executeTransfer).
  const enforce = zkApp.enforceRecipientAllowlist.get();
  const enforcing = enforce.equals(Field(1)).toBoolean();
  const r0 = proposal.receivers[0];
  const r0Empty = r0.address.equals(PublicKey.empty()).toBoolean();
  const dummyMap = new MerkleMap();
  const witness0 = enforcing && !r0Empty
    ? recipientAllowlistStore.getWitness(r0.address)
    : dummyMap.getWitness(Field(0));
  const value0 = enforcing && !r0Empty
    ? recipientAllowlistStore.getValue(r0.address)
    : Field(0);
  const allowlistCheck = new RecipientAllowlistCheck({ witness0, value0 });

  // Forward the operator's memo from the original propose tx into the
  // actual transfer tx — this is the memo the exchange sees, per
  // self-custody spec §4.1 ("included with the transfer for exchange
  // identification").
  const proposalRow = await prisma.proposal.findFirst({
    where: { proposalHash: proposalHash.toString() },
    select: { memo: true },
  });
  const memo = proposalRow?.memo ?? '';

  const tx = await Mina.transaction(
    { sender: feePayer.pub, fee: UInt64.from(100_000_000), memo },
    async () => {
      await zkApp.executeTransfer(
        proposal,
        approvalStore.getWitness(proposalHash),
        approvalCount,
        allowlistCheck,
      );
    },
  );
  console.log('[tx-service] proving executeTransfer...');
  await tx.prove();
  const pending = await tx.sign([feePayer.key]).send();
  if (pending.status !== 'pending') {
    throw new Error(`Submission rejected: ${JSON.stringify((pending as { errors?: unknown[] }).errors ?? [])}`);
  }
  return { txHash: pending.hash };
}
