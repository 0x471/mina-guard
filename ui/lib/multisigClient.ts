// -- Multisig Contract Client (Comlink wrapper) ---------------------------
// Thin main-thread wrapper that delegates heavy o1js work to a Web Worker.
"use client";

import * as Comlink from 'comlink';
import type { WorkerApi } from './multisigClient.worker';
import type { NewProposalInput, Proposal, WalletType } from '@/lib/types';
import { getAuroSignFields, sendTransaction } from '@/lib/auroWallet';
import { signFields as ledgerSignFields, signFeePayer, checkLedgerReady } from '@/lib/ledgerWallet';

/** Re-export types consumed by page components. */
export type { Proposal, NewProposalInput };

/** Configuration describing which wallet should sign fields. */
export interface SignerConfig {
  type: WalletType;
  ledgerAccountIndex?: number;
}

/** Optional callback to receive step-based progress updates from the worker. */
export type OnProgress = (step: string) => void;

/** Context for the Ledger signing modal: 'connecting' for address retrieval, 'signing' for tx signing. */
export type LedgerSigningContext = 'connecting' | 'signing';

/** Listener called when Ledger signing state changes. */
let ledgerSigningListener: ((signing: boolean, context?: LedgerSigningContext) => void) | null = null;

/** Registers a callback that fires when Ledger device interaction starts/stops. */
export function onLedgerSigningChange(fn: (signing: boolean, context?: LedgerSigningContext) => void): () => void {
  ledgerSigningListener = fn;
  return () => { ledgerSigningListener = null; };
}

/** Fires the Ledger signing listener (e.g. to show/hide the "Check Ledger" modal). */
export function setLedgerSigning(signing: boolean, context?: LedgerSigningContext) {
  ledgerSigningListener?.(signing, context);
}

let worker: Worker | null = null;
let api: Comlink.Remote<WorkerApi> | null = null;

/** Lazily creates the shared worker instance. */
function getWorkerApi(): Comlink.Remote<WorkerApi> {
  if (!api) {
    worker = new Worker(
      new URL('./multisigClient.worker.ts', import.meta.url)
    );
    api = Comlink.wrap<WorkerApi>(worker);
  }
  return api;
}

/** Verifies the Ledger device is unlocked and the Mina app is open before starting expensive work. */
export async function assertLedgerReady(signer?: SignerConfig): Promise<void> {
  if (signer?.type !== 'ledger') return;
  await checkLedgerReady();
}

/** Proxied Auro sendTransaction callback for use inside the worker. Returns null for Ledger. */
function proxiedSendTx(signer?: SignerConfig) {
  if (signer?.type === 'ledger') return null;
  return Comlink.proxy((txJson: string) => sendTransaction(txJson));
}

/** Proxied Ledger fee payer signing callback. Returns undefined for Auro. */
function proxiedSignFeePayer(signer?: SignerConfig) {
  if (signer?.type !== 'ledger') return undefined;
  return Comlink.proxy(async (commitment: string) => {
    ledgerSigningListener?.(true, 'signing');
    try {
      return await signFeePayer(commitment, signer.ledgerAccountIndex);
    } finally {
      ledgerSigningListener?.(false);
    }
  });
}

/** Proxied signFields callback that dispatches to Auro or Ledger based on signer config. */
function proxiedSignFields(signer?: SignerConfig) {
  if (signer?.type === 'ledger') {
    return Comlink.proxy(async (fields: Array<string>) => {
      ledgerSigningListener?.(true, 'signing');
      try {
        return await ledgerSignFields(fields, signer.ledgerAccountIndex);
      } finally {
        ledgerSigningListener?.(false);
      }
    });
  }
  return Comlink.proxy(
    (fields: Array<string>) => getAuroSignFields(fields)
  );
}

/** Creates a proxied progress callback for use inside the worker. */
function proxiedProgress(onProgress?: OnProgress) {
  return Comlink.proxy((step: string) => onProgress?.(step));
}

/** Initializes the worker early so compilation starts before the first user action. */
export function warmupWorker() {
  getWorkerApi();
}

/** Sets the worker into e2e test mode with a private key for direct sign/send. */
export async function setTestKey(privateKeyBase58: string) {
  return getWorkerApi().setTestKey(privateKeyBase58);
}

/** Disables proof generation in the worker (for use with lightnet / test environments). */
export async function setSkipProofs(skip: boolean) {
  return getWorkerApi().setSkipProofs(skip);
}

// Expose test helper on window for e2e tests to call via page.evaluate()
// Next.js inlines NEXT_PUBLIC_* at build time; the block is dead-code eliminated
// in production builds where the var is not set.
if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_E2E_TEST === 'true') {
  (window as any).__e2eSetTestKey = async (pk: string) => {
    return getWorkerApi().setTestKey(pk);
  };
  (window as any).__e2eSetSkipProofs = async (skip: boolean) => {
    return getWorkerApi().setSkipProofs(skip);
  };
}

/** Generates a random zkApp keypair in the worker (where o1js is loaded). */
export async function generateKeypair(): Promise<{ privateKey: string; publicKey: string }> {
  return getWorkerApi().generateKeypair();
}


/**
 * Deploys MinaGuard contract account update and submits via Auro or Ledger.
 * The zkApp private key remains in browser memory for this call only.
 */
export async function deployContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().deployContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/** Submits setup transaction with fixed-size owner list and threshold/network bootstrap. */
export async function setupContract(params: {
  zkAppAddress: string;
  feePayerAddress: string;
  owners: string[];
  threshold: number;
  networkId: string;
  delegationKey?: string | null;
  recipientAllowlistRoot?: string | null;
  enforceRecipientAllowlist?: boolean;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().setupContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/** Deploys and initializes the contract in a single transaction. */
export async function deployAndSetupContract(params: {
  feePayerAddress: string;
  zkAppPrivateKeyBase58: string;
  owners: string[];
  threshold: number;
  networkId: string;
  delegationKey?: string | null;
  recipientAllowlistRoot?: string | null;
  enforceRecipientAllowlist?: boolean;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().deployAndSetupContract(params, proxiedSendTx(signer), proxiedProgress(onProgress), proxiedSignFeePayer(signer));
}

/**
 * Backend-proving propose. Worker builds the proposal struct (no compile),
 * Auro signs the proposalHash (1 Field — Ledger-compatible), backend does
 * compile+prove+submit. Avoids the browser WebWorker's MinaGuard compile.
 */
export async function createProposalViaBackend(params: {
  contractAddress: string;
  proposerAddress: string;
  input: NewProposalInput;
  configNonce: number;
  networkId: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  const { proposeViaBackend } = await import('./api');
  const { getAuroSignFields } = await import('./auroWallet');
  await assertLedgerReady(signer);
  const progress = proxiedProgress(onProgress);
  progress('Building proposal...');
  const { proposalJson, proposalHash } = await getWorkerApi().buildNewProposalForBackend({
    contractAddress: params.contractAddress,
    input: params.input,
    configNonce: params.configNonce,
    networkId: params.networkId,
  });
  progress('Requesting Auro signature...');
  const signed = await getAuroSignFields([proposalHash]);
  if (!signed) throw new Error('User rejected or Auro signature failed');
  progress('Submitting to backend prover (proving step)...');
  const result = await proposeViaBackend({
    proposal: proposalJson as never,
    proposer: params.proposerAddress,
    signatureBase58: typeof signed.signature === 'string' ? signed.signature : '',
    memo: params.input.memo,
  });
  if ('error' in result) throw new Error(result.error);

  // User-pays: backend returned a proven-but-unsigned tx. Hand off to
  // Auro, which signs the fee-payer with the connected wallet and
  // submits to the Mina node. Backend never touches fee-payer keys.
  progress('Signing + submitting with Auro (your wallet pays the fee)...');
  const { sendTransaction } = await import('./auroWallet');
  const txHash = await sendTransaction(result.transactionJson);
  if (!txHash) {
    throw new Error('Auro rejected the submission. Try again.');
  }
  progress(`Submitted (${txHash.slice(0, 10)}…). Waiting for indexer to pick it up.`);
  return result.proposalHash;
}

/** Backend-proving approve. */
export async function approveProposalViaBackend(params: {
  contractAddress: string;
  approverAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  const { approveViaBackend } = await import('./api');
  const { getAuroSignFields } = await import('./auroWallet');
  await assertLedgerReady(signer);
  const progress = proxiedProgress(onProgress);
  progress('Serializing proposal...');
  const { proposalJson, proposalHash } = await getWorkerApi().serializeIndexedProposalForBackend({
    proposal: params.proposal,
    fallbackGuardAddress: params.contractAddress,
  });
  progress('Requesting Auro signature...');
  const signed = await getAuroSignFields([proposalHash]);
  if (!signed) throw new Error('User rejected or Auro signature failed');
  progress('Submitting to backend prover...');
  const result = await approveViaBackend({
    proposal: proposalJson as never,
    approver: params.approverAddress,
    signatureBase58: typeof signed.signature === 'string' ? signed.signature : '',
  });
  if ('error' in result) throw new Error(result.error);
  return result.txHash;
}

/**
 * Backend-proving executeTransfer. Other execute* variants still go through
 * the worker for now (follow-up to cover owner/threshold/delegate/child).
 */
export async function executeTransferViaBackendPath(params: {
  contractAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress): Promise<string | null> {
  const { executeTransferViaBackend } = await import('./api');
  const progress = proxiedProgress(onProgress);
  progress('Serializing proposal...');
  const { proposalJson } = await getWorkerApi().serializeIndexedProposalForBackend({
    proposal: params.proposal,
    fallbackGuardAddress: params.contractAddress,
  });
  progress('Submitting to backend prover...');
  const result = await executeTransferViaBackend({ proposal: proposalJson as never });
  if ('error' in result) throw new Error(result.error);
  return result.txHash;
}

/**
 * Unified backend-proving execute path. Dispatches on proposal.txType /
 * destination server-side — handles every @method except propose/approve/
 * single-key-delegate (which need the user's signature) and CREATE_CHILD
 * (finalized via the wizard's separate deployAndSetupChild flow).
 *
 * Execute methods are permissionless in the contract — no Auro prompt.
 */
export async function executeAnyViaBackend(params: {
  contractAddress: string;
  proposal: Proposal;
  childAddress?: string;
  enabled?: boolean;
}, onProgress?: OnProgress): Promise<string | null> {
  const { executeViaBackend } = await import('./api');
  const progress = proxiedProgress(onProgress);
  progress('Serializing proposal...');
  const { proposalJson } = await getWorkerApi().serializeIndexedProposalForBackend({
    proposal: params.proposal,
    fallbackGuardAddress: params.contractAddress,
  });
  progress('Submitting to backend prover...');
  const result = await executeViaBackend({
    proposal: proposalJson as never,
    childAddress: params.childAddress,
    enabled: params.enabled,
  });
  if ('error' in result) throw new Error(result.error);
  return result.txHash;
}

/**
 * Rotates a guard's staking delegate using its committed delegation key.
 * The connected wallet must be that delegation key. Delegate = null/empty
 * means "undelegate to self." Ledger is not supported on this path —
 * the contract verifies a signature over a 7-field message which Ledger
 * cannot sign on-device.
 */
export async function executeSingleKeyDelegate(params: {
  guardAddress: string;
  delegationKeyPub: string;
  delegate: string | null;
  expiryBlock?: string | null;
  feePayerAddress: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  if (signer && 'type' in signer && (signer as { type?: string }).type === 'ledger') {
    throw new Error(
      'Ledger is not supported for single-key delegation. Use Auro, or fall back to multisig executeDelegate.',
    );
  }
  await assertLedgerReady(signer);
  return getWorkerApi().executeSingleKeyDelegate(
    params,
    proxiedSignFields(signer),
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}

/** Creates an on-chain proposal via zkApp.propose(). Returns the proposalHash on success. */
export async function createOnchainProposal(params: {
  contractAddress: string;
  proposerAddress: string;
  input: NewProposalInput;
  configNonce: number;
  networkId: string;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().createOnchainProposal(
    params,
    proxiedSignFields(signer),
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}

/** Submits an on-chain approveProposal tx. Returns the tx hash string on success. */
export async function approveProposalOnchain(params: {
  contractAddress: string;
  approverAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().approveProposalOnchain(
    params,
    proxiedSignFields(signer),
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}

/** Submits the appropriate single-sig execute* transaction for the given proposal. */
export async function executeProposalOnchain(params: {
  contractAddress: string;
  executorAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().executeProposalOnchain(
    params,
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}

/**
 * Computes the createChild proposal data hash + generates a fresh child keypair.
 * Returns everything the wizard needs to (a) submit a CREATE_CHILD proposal
 * on the parent, then (b) finalize via deployAndSetupChild later.
 */
export async function computeCreateChildConfigHash(params: {
  childOwners: string[];
  childThreshold: number;
  childDelegationKey?: string | null;
  childRecipientAllowlistRoot?: string | null;
  childEnforceRecipientAllowlist?: boolean;
  childInitialDelegate?: string | null;
}): Promise<{
  ownersCommitment: string;
  configHash: string;
  childAddressKeypair: { privateKey: string; publicKey: string };
}> {
  return getWorkerApi().computeCreateChildConfigHash(params);
}

/**
 * Deploys a new child guard at `childPrivateKey` and runs `executeSetupChild`
 * in the same transaction. Used to finalize a CREATE_CHILD proposal once the
 * parent has reached threshold.
 */
export async function deployAndSetupChildOnchain(params: {
  parentAddress: string;
  childPrivateKeyBase58: string;
  feePayerAddress: string;
  childOwners: string[];
  childThreshold: number;
  proposal: Proposal;
  childDelegationKey?: string | null;
  childRecipientAllowlistRoot?: string | null;
  childEnforceRecipientAllowlist?: boolean;
  childInitialDelegate?: string | null;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().deployAndSetupChildOnchain(
    params,
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}

/**
 * Executes a REMOTE child-lifecycle proposal on the child guard:
 * RECLAIM_CHILD / DESTROY_CHILD / ENABLE_CHILD_MULTI_SIG.
 */
export async function executeChildLifecycleOnchain(params: {
  childAddress: string;
  parentAddress: string;
  executorAddress: string;
  proposal: Proposal;
}, onProgress?: OnProgress, signer?: SignerConfig): Promise<string | null> {
  await assertLedgerReady(signer);
  return getWorkerApi().executeChildLifecycleOnchain(
    params,
    proxiedSendTx(signer),
    proxiedProgress(onProgress),
    proxiedSignFeePayer(signer),
  );
}
