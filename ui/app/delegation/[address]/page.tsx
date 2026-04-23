'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Field, PublicKey, Poseidon, UInt32 } from 'o1js';
import { DELEGATION_KEY_HASH_PREFIX } from 'contracts';
import { useAppContext } from '@/lib/app-context';
import {
  fetchChildren,
  fetchBalance,
  delegateSingleKeyViaBackend,
} from '@/lib/api';
import { getAuroSignFields } from '@/lib/auroWallet';
import {
  truncateAddress,
  formatMina,
  type ContractSummary,
} from '@/lib/types';

type Row = {
  contract: ContractSummary;
  isParent: boolean;
  balance: string | null;
  liveDelegate: string | null;
};

type Filter = 'all' | 'delegating' | 'not';

export default function DelegationPage() {
  const params = useParams<{ address: string }>();
  const urlAddress = params?.address ?? null;
  const { wallet, multisig, contracts, selectContract, startOperation, isOperating } =
    useAppContext();

  const [filter, setFilter] = useState<Filter>('all');
  const [children, setChildren] = useState<ContractSummary[]>([]);
  const [rows, setRows] = useState<Row[]>([]);

  // Sync URL → selected contract (same pattern as /accounts/[address]).
  useEffect(() => {
    if (!urlAddress) return;
    if (multisig?.address === urlAddress) return;
    const exists = contracts.some((c) => c.address === urlAddress);
    if (exists) void selectContract(urlAddress);
  }, [urlAddress, contracts, multisig?.address, selectContract]);

  // Load children whenever the selected guard changes.
  useEffect(() => {
    if (!multisig) return;
    let cancelled = false;
    void fetchChildren(multisig.address).then((cs) => {
      if (!cancelled) setChildren(cs);
    });
    return () => {
      cancelled = true;
    };
  }, [multisig]);

  // Fetch balance + live delegate for parent + each child.
  useEffect(() => {
    if (!multisig) return;
    let cancelled = false;
    const all = [multisig, ...children];
    (async () => {
      const out: Row[] = await Promise.all(
        all.map(async (c) => {
          const [balance, liveDelegate] = await Promise.all([
            fetchBalance(c.address).catch(() => null),
            fetchLiveDelegate(c.address).catch(() => null),
          ]);
          return {
            contract: c,
            isParent: c.address === multisig.address,
            balance,
            liveDelegate,
          };
        }),
      );
      if (!cancelled) setRows(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [multisig, children]);

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) => {
      const d = r.liveDelegate ?? r.contract.delegate;
      const delegating = Boolean(d) && d !== r.contract.address;
      return filter === 'delegating' ? delegating : !delegating;
    });
  }, [rows, filter]);

  if (!urlAddress) {
    return <div className="p-8 text-sm opacity-70">No account selected.</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <header className="space-y-2">
        <Link
          href={`/accounts/${urlAddress}`}
          className="text-xs opacity-70 hover:underline"
        >
          ← Back to account
        </Link>
        <h1 className="text-2xl font-bold">Delegation</h1>
        <p className="text-sm opacity-70">
          Block producer staking delegation across this guard and its child accounts.
        </p>
      </header>

      <section className="bg-blue-900/20 border border-blue-500/40 rounded-lg p-4 text-sm">
        <p className="font-semibold mb-1">About Delegation</p>
        <p className="opacity-80">
          When delegating, the account&apos;s staking weight is assigned to a block
          producer. MINA does not leave your account. Delegation changes take ~2–4 weeks
          (epoch transition) to become active.
        </p>
      </section>

      <nav className="flex gap-2 text-xs">
        {(['all', 'delegating', 'not'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md border transition-colors ${
              filter === f
                ? 'bg-safe-green text-safe-dark border-safe-green font-semibold'
                : 'border-safe-border opacity-80 hover:bg-safe-hover'
            }`}
          >
            {f === 'all' ? 'All' : f === 'delegating' ? 'Delegating' : 'Not Delegating'}
          </button>
        ))}
        <span className="ml-auto text-xs opacity-60 self-center">
          {filtered.length} of {rows.length}
        </span>
      </nav>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm opacity-60 italic text-center py-12">
            Loading guard state…
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm opacity-60 italic text-center py-12">
            No accounts match this filter.
          </p>
        ) : (
          filtered.map((row) => (
            <DelegationRow
              key={row.contract.address}
              row={row}
              walletAddress={wallet.address}
              walletType={wallet.type}
              startOperation={startOperation}
              isOperating={isOperating}
            />
          ))
        )}
      </div>

      {multisig && !multisig.parent && (
        <div className="border-t border-safe-border pt-6 mt-6">
          <Link
            href={`/accounts/new?parent=${multisig.address}`}
            className="inline-flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110"
          >
            ➕ Create Block Producer Child
          </Link>
          <p className="text-xs opacity-60 mt-2">
            Deploys a new child guard delegating to a new block producer. Runs through
            the CREATE_CHILD multisig proposal flow.
          </p>
        </div>
      )}
    </div>
  );
}

function DelegationRow({
  row,
  walletAddress,
  walletType,
  startOperation,
  isOperating,
}: {
  row: Row;
  walletAddress: string | null;
  walletType: 'auro' | 'ledger' | null;
  startOperation: (
    label: string,
    fn: (onProgress: (step: string) => void) => Promise<string | null>,
  ) => Promise<void>;
  isOperating: boolean;
}) {
  const c = row.contract;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [undelegate, setUndelegate] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState<string | null>(null);

  const delegate = row.liveDelegate ?? c.delegate;
  const isSelf = !delegate || delegate === c.address;
  const singleKeyConfigured = Boolean(c.delegationKeyHash) && c.delegationKeyHash !== '0';
  const walletMatches = useMemo(() => {
    if (!walletAddress || !c.delegationKeyHash) return false;
    try {
      const pub = PublicKey.fromBase58(walletAddress);
      const h = Poseidon.hashWithPrefix(DELEGATION_KEY_HASH_PREFIX, pub.toFields());
      return h.toString() === c.delegationKeyHash;
    } catch {
      return false;
    }
  }, [walletAddress, c.delegationKeyHash]);

  const ledgerBlocked = walletType === 'ledger';
  const canRotate = singleKeyConfigured && walletMatches && !ledgerBlocked;
  const disabledReason = !singleKeyConfigured
    ? 'Single-key delegation not configured at setup'
    : !walletAddress
      ? 'Connect a wallet first'
      : !walletMatches
        ? 'Connected wallet is not the delegation key for this guard'
        : ledgerBlocked
          ? 'Ledger cannot sign multi-field messages'
          : null;

  const submit = () => {
    setError(null);
    if (!canRotate) {
      setError(disabledReason ?? 'Cannot rotate right now.');
      return;
    }
    const t = undelegate ? null : target.trim();
    if (!undelegate && (!t || !t.startsWith('B62') || t.length < 50)) {
      setError('Enter a valid B62… block producer address or toggle undelegate.');
      return;
    }
    if (expiry && !/^\d+$/.test(expiry)) {
      setError('Expiry block must be a non-negative integer (0 = no expiry).');
      return;
    }
    if (c.networkId == null || c.delegationNonce == null) {
      setError('Guard state not fully indexed yet — try again in a moment.');
      return;
    }

    const delegatePk = t ? PublicKey.fromBase58(t) : PublicKey.empty();
    const guardPub = PublicKey.fromBase58(c.address);
    const networkIdField = Field(c.networkId);
    const nonceField = Field(c.delegationNonce);
    const expiryField = UInt32.from(expiry || '0').value;

    // Canonical signed message — order is ABI-bound, must match contract.
    const msgFields = [
      ...delegatePk.toFields(),
      ...guardPub.toFields(),
      networkIdField,
      nonceField,
      expiryField,
    ].map((f) => f.toString());

    void startOperation('Requesting Auro signature…', async (onProgress) => {
      onProgress('Signing canonical message with Auro…');
      const signed = await getAuroSignFields(msgFields);
      if (!signed) {
        throw new Error('User rejected or Auro signature failed.');
      }
      onProgress('Submitting to backend prover…');
      const result = await delegateSingleKeyViaBackend({
        guardAddress: c.address,
        delegate: t,
        delegationKeyPub: walletAddress!,
        expiryBlock: expiry || null,
        signatureBase58: signed.signature,
      });
      if ('error' in result) {
        throw new Error(result.error);
      }
      return `Delegate rotated (tx ${result.txHash.slice(0, 10)}…)`;
    });

    setOpen(false);
    setTarget('');
    setUndelegate(false);
    setExpiry('');
  };

  return (
    <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider opacity-70">
              {row.isParent ? 'Parent (Treasury)' : 'Child (BP Guard)'}
            </span>
            <Link
              href={`/accounts/${c.address}`}
              className="text-[10px] text-safe-green hover:underline"
            >
              view account →
            </Link>
          </div>
          <p
            className="font-mono text-sm truncate"
            title={c.address}
          >
            {truncateAddress(c.address, 12)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] uppercase opacity-70">Balance</p>
          <p className="font-mono text-sm">
            {row.balance ? `${formatMina(row.balance)} MINA` : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 text-xs border-t border-safe-border pt-3">
        <div className="min-w-0">
          <p className="uppercase opacity-70 mb-1">Current delegate</p>
          <p
            className={`font-mono break-all ${isSelf ? 'text-amber-300' : ''}`}
            title={delegate ?? undefined}
          >
            {!delegate && !c.delegate
              ? '(loading…)'
              : isSelf
                ? 'unstaked (points to self)'
                : truncateAddress(delegate!, 10)}
          </p>
        </div>
        <div>
          <p className="uppercase opacity-70 mb-1">Rotations so far</p>
          <p className="font-mono">{c.delegationNonce ?? 0}</p>
          <p className="uppercase opacity-70 mt-2 mb-1">Mode</p>
          <p className="font-mono text-[10px]">
            {singleKeyConfigured ? 'single-key + multisig' : 'multisig only'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setOpen(!open)}
          disabled={isOperating || !canRotate}
          title={disabledReason ?? undefined}
          className="bg-safe-green text-safe-dark font-semibold rounded-lg px-3 py-1.5 text-xs hover:brightness-110 disabled:opacity-50"
        >
          {open ? 'Cancel' : 'Change delegation'}
        </button>
        {!row.isParent && (
          <Link
            href={`/accounts/${c.address}`}
            className="text-[11px] opacity-80 hover:underline"
          >
            Reclaim / Destroy →
          </Link>
        )}
        {!canRotate && disabledReason && (
          <span className="text-[11px] opacity-60 ml-1">{disabledReason}</span>
        )}
      </div>

      {open && (
        <div className="mt-4 border-t border-safe-border pt-4 space-y-3">
          <p className="text-xs opacity-80 italic">
            Changes take ~2–4 weeks (epoch transition) to become active. This is a
            zero-value transaction and does not move funds.
          </p>
          <label className="space-y-1 block">
            <span className="text-xs opacity-80">Block producer address</span>
            <input
              type="text"
              disabled={undelegate}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setError(null);
              }}
              placeholder="B62… (new delegation target)"
              className="w-full bg-safe-dark border border-safe-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-safe-green disabled:opacity-40"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={undelegate}
              onChange={(e) => setUndelegate(e.target.checked)}
            />
            Undelegate (point stake back to self)
          </label>
          <label className="space-y-1 block">
            <span className="text-xs opacity-80">
              Expiry block height (0 = no expiry)
            </span>
            <input
              type="text"
              value={expiry}
              onChange={(e) => {
                setExpiry(e.target.value);
                setError(null);
              }}
              placeholder="0"
              className="w-full bg-safe-dark border border-safe-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-safe-green"
            />
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end">
            <button
              onClick={submit}
              disabled={isOperating}
              className="bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-xs hover:brightness-110 disabled:opacity-50"
            >
              {isOperating ? 'Signing…' : 'Submit'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

async function fetchLiveDelegate(address: string): Promise<string | null> {
  const mina =
    process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'http://127.0.0.1:18080/graphql';
  const q = `{ account(publicKey: "${address}") { delegateAccount { publicKey } } }`;
  const res = await fetch(mina, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const body = (await res.json()) as {
    data?: { account?: { delegateAccount?: { publicKey?: string } } };
  };
  return body?.data?.account?.delegateAccount?.publicKey ?? null;
}
