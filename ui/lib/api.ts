import {
  type ApprovalRecord,
  type ContractSummary,
  type IndexerStatus,
  type OwnerRecord,
  type Proposal,
  type ProposalReceiver,
  normalizeDestination,
  normalizeTxType,
} from '@/lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

/**
 * Returns the Authorization header for backend calls when a NextAuth
 * session is active. Short-circuits in local dev (AUTH_DISABLED) and
 * when there is no session (public surface). The backend middleware
 * enforces authentication independently; this is just courtesy injection.
 */
async function authHeaders(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_AUTH_DISABLED === 'true') return {};
  if (typeof window === 'undefined') return {};
  try {
    const mod = await import('next-auth/react');
    const session = await mod.getSession();
    const token = (session as unknown as { backendToken?: string })?.backendToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** Fetches indexer status from backend monitoring endpoint. */
export async function fetchIndexerStatus(): Promise<IndexerStatus | null> {
  return getJson<IndexerStatus>('/api/indexer/status');
}

/** Fetches all discovered contracts from backend. */
export async function fetchContracts(): Promise<ContractSummary[]> {
  const data = await getJson<Array<Record<string, unknown>>>('/api/contracts');
  if (!data) return [];
  return data.map((item) => toContractSummary(item));
}

/** Fetches a single contract record by address. */
export async function fetchContract(address: string): Promise<ContractSummary | null> {
  const data = await getJson<Record<string, unknown>>(`/api/contracts/${address}`);
  return data ? toContractSummary(data) : null;
}

/** Lists direct subaccounts of a parent contract. */
export async function fetchChildren(parentAddress: string): Promise<ContractSummary[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${parentAddress}/children`,
  );
  if (!data) return [];
  return data.map((item) => toContractSummary(item));
}

/**
 * Asks the backend to compile + prove + submit a deploy+setup transaction.
 * Bypasses the browser WebWorker entirely — no in-browser MinaGuard.compile
 * on first load. Lightnet-only right now (backend pulls a funded fee-payer
 * from the lightnet account manager).
 */
export async function deployAndSetupViaBackend(params: {
  owners: string[];
  threshold: number;
  networkId: string;
  delegationKey?: string | null;
  recipientAllowlistRoot?: string | null;
  enforceRecipientAllowlist?: boolean;
}): Promise<{
  zkAppAddress: string;
  zkAppPrivateKey: string;
  txHash: string;
  feePayerAddress: string;
} | { error: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/deploy-and-setup`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) {
      return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    }
    return body as {
      zkAppAddress: string;
      zkAppPrivateKey: string;
      txHash: string;
      feePayerAddress: string;
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Shape of a proposal payload sent to backend-proving endpoints. All scalar
 * fields are decimal-string form of their Field value; PublicKeys are base58.
 */
export interface BackendProposalInput {
  receivers: Array<{ address: string; amount: string }>;
  tokenId: string;
  txType: string;
  data: string;
  uid: string;
  configNonce: string;
  expiryBlock: string;
  networkId: string;
  guardAddress: string;
  destination: string;
  childAccount: string;
}

/** Backend-proving propose. Auro signs proposalHash (1 Field). */
export async function proposeViaBackend(params: {
  proposal: BackendProposalInput;
  proposer: string;
  signatureBase58: string;
  memo?: string;
}): Promise<
  | { transactionJson: string; proposalHash: string }
  | { error: string }
> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/propose`, {
      method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    return body as { transactionJson: string; proposalHash: string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Backend-proving approve. Auro signs proposalHash (1 Field). */
export async function approveViaBackend(params: {
  proposal: BackendProposalInput;
  approver: string;
  signatureBase58: string;
}): Promise<{ txHash: string } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/approve`, {
      method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    return body as { txHash: string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Backend-proving executeTransfer. Server rebuilds allowlist witness. */
export async function executeTransferViaBackend(params: {
  proposal: BackendProposalInput;
}): Promise<{ txHash: string } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/execute-transfer`, {
      method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    return body as { txHash: string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unified backend-proving execute dispatcher. Server routes on
 * `proposal.txType` + `destination` to call the right zkApp method. Handles
 * every execute* variant — no Auro round-trip because these methods are
 * permissionless once the approval threshold is met.
 */
export async function executeViaBackend(params: {
  proposal: BackendProposalInput;
  childAddress?: string;
  enabled?: boolean;
}): Promise<{ txHash: string } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/execute`, {
      method: 'POST', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    return body as { txHash: string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Backend-proving single-key delegate. UI collects the Auro signature of
 * the canonical 7-field message (produced by `signFields` on the main
 * thread) and hands it to the backend. Backend proves + submits.
 */
export async function delegateSingleKeyViaBackend(params: {
  guardAddress: string;
  delegate: string | null;
  delegationKeyPub: string;
  expiryBlock: string | null;
  signatureBase58: string;
}): Promise<{ txHash: string; feePayerAddress: string } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE}/api/tx/delegate-single-key`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await response.json().catch(() => ({ error: 'invalid JSON from backend' }));
    if (!response.ok) {
      return { error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
    }
    return body as { txHash: string; feePayerAddress: string };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Indexed inbound transfer record populated by the IncomingPoller. */
export interface IncomingTransferRecord {
  id: number;
  fromAddress: string;
  amount: string;
  memo: string | null;
  blockHeight: number;
  txHash: string;
  createdAt: string;
}

/** Fetches inbound transfers for a contract, most-recent first. */
export async function fetchIncomingTransfers(
  address: string,
  options?: { limit?: number },
): Promise<IncomingTransferRecord[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/incoming${qs}`,
  );
  if (!data) return [];
  return data.map((item) => ({
    id: asNumber(item.id),
    fromAddress: asString(item.fromAddress) ?? '',
    amount: asString(item.amount) ?? '0',
    memo: asNullableString(item.memo),
    blockHeight: asNumber(item.blockHeight),
    txHash: asString(item.txHash) ?? '',
    createdAt: asString(item.createdAt) ?? '',
  }));
}

/** A UI-layer alias for a recipient address (e.g. "Kraken" → B62…). */
export interface RecipientAliasRecord {
  id: number;
  alias: string;
  address: string;
  createdBy: string | null;
  createdAt: string;
}

/** Fetches all recipient aliases for a contract, alphabetical. */
export async function fetchRecipientAliases(
  address: string,
): Promise<RecipientAliasRecord[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/recipient-aliases`,
  );
  if (!data) return [];
  return data.map((item) => ({
    id: asNumber(item.id),
    alias: asString(item.alias) ?? '',
    address: asString(item.address) ?? '',
    createdBy: asNullableString(item.createdBy),
    createdAt: asString(item.createdAt) ?? '',
  }));
}

/** Creates or upserts a recipient alias. Returns the row. */
export async function createRecipientAlias(
  contractAddress: string,
  params: { alias: string; address: string; createdBy?: string | null },
): Promise<RecipientAliasRecord | { error: string }> {
  try {
    const res = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/recipient-aliases`,
      {
        method: 'POST',
        headers: { ...(await authHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify(params),
      },
    );
    const body = await res.json().catch(() => ({ error: 'invalid JSON' }));
    if (!res.ok) {
      return {
        error:
          typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      };
    }
    return {
      id: asNumber(body.id),
      alias: asString(body.alias) ?? '',
      address: asString(body.address) ?? '',
      createdBy: asNullableString(body.createdBy),
      createdAt: asString(body.createdAt) ?? '',
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Deletes a recipient alias by id. */
export async function deleteRecipientAlias(
  contractAddress: string,
  aliasId: number,
): Promise<{ ok: true } | { error: string }> {
  try {
    const res = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/recipient-aliases/${aliasId}`,
      { method: 'DELETE', headers: await authHeaders() },
    );
    const body = await res.json().catch(() => ({ error: 'invalid JSON' }));
    if (!res.ok) {
      return {
        error:
          typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Lists active recipient-allowlist entries (addresses currently allowed). */
export async function fetchRecipientAllowlist(address: string): Promise<string[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/recipient-allowlist?active=true`,
  );
  if (!data) return [];
  return data
    .map((row) => (typeof row.address === 'string' ? row.address : ''))
    .filter((a) => a !== '');
}

/** Fetches owner list for the selected contract. */
export async function fetchOwners(address: string): Promise<OwnerRecord[]> {
  const data = await getJson<Array<Record<string, unknown>>>(`/api/contracts/${address}/owners`);
  if (!data) return [];
  return data.map((item) => ({
    address: asString(item.address) ?? '',
    ownerHash: asNullableString(item.ownerHash),
    index: asNullableNumber(item.index),
    active: asBoolean(item.active),
  }));
}

/** Fetches proposals for a contract with optional status filtering. */
export async function fetchProposals(
  address: string,
  options?: { status?: string; limit?: number; offset?: number }
): Promise<Proposal[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));

  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/proposals${qs}`
  );
  if (!data) return [];
  return data.map((item) => toProposal(item));
}

/** Fetches one proposal by proposalHash for detail pages. */
export async function fetchProposal(
  address: string,
  proposalHash: string
): Promise<Proposal | null> {
  const data = await getJson<Record<string, unknown>>(
    `/api/contracts/${address}/proposals/${proposalHash}`
  );
  return data ? toProposal(data) : null;
}

/** Fetches all approval rows for one proposal. */
export async function fetchApprovals(
  address: string,
  proposalHash: string
): Promise<ApprovalRecord[]> {
  const data = await getJson<Array<Record<string, unknown>>>(
    `/api/contracts/${address}/proposals/${proposalHash}/approvals`
  );
  if (!data) return [];
  return data.map((item) => ({
    approver: asString(item.approver) ?? '',
    approvalRaw: asNullableString(item.approvalRaw),
    blockHeight: asNullableNumber(item.blockHeight),
    createdAt: asString(item.createdAt) ?? new Date(0).toISOString(),
  }));
}

/** Fetches MINA token balance (in nanomina) for a wallet address. */
export async function fetchBalance(address: string): Promise<string | null> {
  const data = await getJson<{ balance: string }>(`/api/account/${address}/balance`);
  return data?.balance ?? null;
}

/** Generic JSON fetch helper with null-on-error semantics for resilient polling. */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const headers = await authHeaders();
    const response = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      headers,
    });
    if (!response.ok) {
      console.error(`[api] getJson(${path}) returned ${response.status}:`, await response.text());
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    console.error(`[api] getJson(${path}) failed:`, err);
    return null;
  }
}

/** Normalizes backend contract rows into strict typed frontend summary objects. */
function toContractSummary(input: Record<string, unknown>): ContractSummary {
  return {
    address: asString(input.address) ?? '',
    networkId: asNullableString(input.networkId),
    ownersCommitment: asNullableString(input.ownersCommitment),
    threshold: asNullableNumber(input.threshold),
    numOwners: asNullableNumber(input.numOwners),
    proposalCounter: asNullableNumber(input.proposalCounter),
    configNonce: asNullableNumber(input.configNonce),
    delegate: asNullableString(input.delegate),
    parent: asNullableString(input.parent),
    childMultiSigEnabled: asNullableBoolean(input.childMultiSigEnabled),
    delegationKeyHash: asNullableString(input.delegationKeyHash),
    delegationNonce: asNullableNumber(input.delegationNonce),
    recipientAllowlistRoot: asNullableString(input.recipientAllowlistRoot),
    enforceRecipientAllowlist: asNullableBoolean(input.enforceRecipientAllowlist),
    discoveredAt: asString(input.discoveredAt) ?? new Date(0).toISOString(),
    lastSyncedAt: asNullableString(input.lastSyncedAt),
  };
}

/** Normalizes backend proposal rows and txType encodings for UI components. */
function toProposal(input: Record<string, unknown>): Proposal {
  const receivers = asReceivers(input.receivers);
  const totalAmount = asNullableString(input.totalAmount)
    ?? (receivers.length > 0
      ? receivers.reduce((sum, receiver) => sum + BigInt(receiver.amount), 0n).toString()
      : null);
  return {
    proposalHash: asString(input.proposalHash) ?? '',
    proposer: asNullableString(input.proposer),
    toAddress: asNullableString(input.toAddress),
    tokenId: asNullableString(input.tokenId),
    txType: normalizeTxType(asNullableString(input.txType)),
    data: asNullableString(input.data),
    uid: asNullableString(input.uid),
    configNonce: asNullableString(input.configNonce),
    expiryBlock: asNullableString(input.expiryBlock),
    networkId: asNullableString(input.networkId),
    guardAddress: asNullableString(input.guardAddress),
    destination: normalizeDestination(asNullableString(input.destination)),
    childAccount: asNullableString(input.childAccount),
    status: asProposalStatus(input.status),
    approvalCount: asNumber(input.approvalCount),
    createdAtBlock: asNullableNumber(input.createdAtBlock),
    executedAtBlock: asNullableNumber(input.executedAtBlock),
    createdAt: asString(input.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asString(input.updatedAt) ?? new Date(0).toISOString(),
    receivers,
    recipientCount: asNullableNumber(input.recipientCount) ?? receivers.length,
    totalAmount,
    memo: asNullableString(input.memo),
    createTxHash: asNullableString(input.createTxHash),
    executeTxHash: asNullableString(input.executeTxHash),
  };
}

/** Converts unknown values to string while preserving nullability. */
function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/** Converts unknown values to strict number with zero fallback for counters. */
function asNumber(value: unknown): number {
  const raw = asNullableNumber(value);
  return raw ?? 0;
}

/** Converts unknown values to nullable number for optional numeric fields. */
function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Converts unknown values to strict booleans. */
function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  if (typeof value === 'number') return value === 1;
  return false;
}

/** Converts unknown values to nullable boolean; distinguishes unset vs false. */
function asNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return null;
  }
  if (typeof value === 'number') return value === 1;
  return null;
}

/** Converts unknown values to nullable strings for optional columns. */
function asNullableString(value: unknown): string | null {
  const stringValue = asString(value);
  return stringValue ?? null;
}

/** Converts status text to one of the allowed proposal status values. */
function asProposalStatus(value: unknown): Proposal['status'] {
  const text = asString(value);
  if (text === 'executed' || text === 'expired') return text;
  return 'pending';
}

function asReceivers(value: unknown): ProposalReceiver[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    return {
      index: asNullableNumber(record.index) ?? index,
      address: asString(record.address) ?? '',
      amount: asString(record.amount) ?? '0',
    };
  });
}

/** Fetches all raw indexed events for a contract using paginated backend API reads. */
export async function fetchAllEvents(contractAddress: string): Promise<Array<{ eventType: string; payload: unknown }>> {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const response = await fetch(
      `${API_BASE}/api/contracts/${contractAddress}/events?limit=${limit}&offset=${offset}`,
      { cache: 'no-store', headers: await authHeaders() }
    );

    if (!response.ok) {
      console.error(`[api] fetchAllEvents page at offset=${offset} returned ${response.status}`);
      break;
    }

    const batch = (await response.json()) as Array<{ eventType: string; payload: unknown }>;
    events.push(
      ...batch.map((event) => ({
        eventType: event.eventType,
        payload:
          typeof event.payload === 'string'
            ? safeParseJson(event.payload)
            : event.payload,
      }))
    );

    if (batch.length < limit) break;
    offset += limit;
  }

  return events.reverse();
}

/** Parses JSON strings defensively when backend stores raw payload text. */
function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
