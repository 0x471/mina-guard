'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useAppContext } from '@/lib/app-context';
import {
  fetchProposals,
  fetchIncomingTransfers,
  fetchApprovals,
  type IncomingTransferRecord,
} from '@/lib/api';
import {
  truncateAddress,
  formatMina,
  TX_TYPE_LABELS,
  type Proposal,
} from '@/lib/types';
import AccountTabs from '@/components/AccountTabs';
import { fetchIndexerStatus } from '@/lib/api';

type Filter =
  | 'all'
  | 'pending'
  | 'completed'
  | 'inbound'
  | 'outbound'
  | 'needs-sig';

type Row =
  | {
      kind: 'proposal';
      proposal: Proposal;
      needsMySig: boolean;
      isExpired: boolean;
      timestamp: number;
    }
  | {
      kind: 'incoming';
      incoming: IncomingTransferRecord;
      timestamp: number;
    };

export default function ActivityPage() {
  const params = useParams<{ address: string }>();
  const urlAddress = params?.address ?? null;
  const { wallet, multisig, contracts, owners, selectContract } = useAppContext();

  const [filter, setFilter] = useState<Filter>('all');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [incoming, setIncoming] = useState<IncomingTransferRecord[]>([]);
  const [approvalMap, setApprovalMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [chainHeight, setChainHeight] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchIndexerStatus().then((s) => {
      if (!cancelled) setChainHeight(s?.latestChainHeight ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!urlAddress) return;
    if (multisig?.address === urlAddress) return;
    const exists = contracts.some((c) => c.address === urlAddress);
    if (exists) void selectContract(urlAddress);
  }, [urlAddress, contracts, multisig?.address, selectContract]);

  useEffect(() => {
    if (!urlAddress) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [ps, inc] = await Promise.all([
        fetchProposals(urlAddress, { limit: 200 }).catch(() => []),
        fetchIncomingTransfers(urlAddress, { limit: 200 }).catch(() => []),
      ]);
      if (cancelled) return;
      setProposals(ps);
      setIncoming(inc);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [urlAddress]);

  // Fetch approval lists for pending proposals so "Needs My Signature" works.
  useEffect(() => {
    if (!urlAddress || !wallet.address) return;
    const pending = proposals.filter((p) => p.status === 'pending');
    if (pending.length === 0) {
      setApprovalMap({});
      return;
    }
    let cancelled = false;
    (async () => {
      const pairs = await Promise.all(
        pending.map(async (p) => {
          const rows = await fetchApprovals(urlAddress, p.proposalHash).catch(
            () => [],
          );
          return [p.proposalHash, rows.map((r) => r.approver)] as const;
        }),
      );
      if (cancelled) return;
      setApprovalMap(Object.fromEntries(pairs));
    })();
    return () => {
      cancelled = true;
    };
  }, [urlAddress, proposals, wallet.address]);

  const isOwner = useMemo(
    () => owners.some((o) => o.address === wallet.address),
    [owners, wallet.address],
  );

  const rows: Row[] = useMemo(() => {
    const proposalRows: Row[] = proposals.map((p) => {
      const approvals = approvalMap[p.proposalHash] ?? [];
      const alreadyApproved = wallet.address
        ? approvals.includes(wallet.address)
        : false;
      const needsMySig =
        p.status === 'pending' && isOwner && !alreadyApproved;
      const expiry = Number(p.expiryBlock ?? '0');
      const isExpired =
        p.status === 'pending' &&
        expiry > 0 &&
        chainHeight !== null &&
        chainHeight >= expiry;
      return {
        kind: 'proposal',
        proposal: p,
        needsMySig,
        isExpired,
        timestamp: Date.parse(p.createdAt) || 0,
      };
    });
    const incomingRows: Row[] = incoming.map((i) => ({
      kind: 'incoming',
      incoming: i,
      timestamp: Date.parse(i.createdAt) || 0,
    }));
    return [...proposalRows, ...incomingRows].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
  }, [proposals, incoming, approvalMap, wallet.address, isOwner, chainHeight]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      switch (filter) {
        case 'all':
          return true;
        case 'pending':
          return r.kind === 'proposal' && r.proposal.status === 'pending';
        case 'completed':
          return r.kind === 'proposal' && r.proposal.status !== 'pending';
        case 'inbound':
          return r.kind === 'incoming';
        case 'outbound':
          return r.kind === 'proposal';
        case 'needs-sig':
          return r.kind === 'proposal' && r.needsMySig;
      }
    });
  }, [rows, filter]);

  if (!urlAddress) {
    return <div className="p-8 text-sm opacity-70">No account selected.</div>;
  }

  const counts = {
    all: rows.length,
    pending: rows.filter(
      (r) => r.kind === 'proposal' && r.proposal.status === 'pending',
    ).length,
    completed: rows.filter(
      (r) => r.kind === 'proposal' && r.proposal.status !== 'pending',
    ).length,
    inbound: rows.filter((r) => r.kind === 'incoming').length,
    outbound: rows.filter((r) => r.kind === 'proposal').length,
    needsSig: rows.filter((r) => r.kind === 'proposal' && r.needsMySig).length,
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <AccountTabs address={urlAddress} active="activity" />
      <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Activity</h1>
        <p className="text-sm opacity-70 font-mono truncate" title={urlAddress}>
          {truncateAddress(urlAddress, 12)}
        </p>
      </header>

      <nav className="flex gap-2 text-xs flex-wrap">
        <FilterChip
          label="All"
          count={counts.all}
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <FilterChip
          label="Pending"
          count={counts.pending}
          active={filter === 'pending'}
          onClick={() => setFilter('pending')}
        />
        <FilterChip
          label="Completed"
          count={counts.completed}
          active={filter === 'completed'}
          onClick={() => setFilter('completed')}
        />
        <FilterChip
          label="Inbound"
          count={counts.inbound}
          active={filter === 'inbound'}
          onClick={() => setFilter('inbound')}
        />
        <FilterChip
          label="Outbound"
          count={counts.outbound}
          active={filter === 'outbound'}
          onClick={() => setFilter('outbound')}
        />
        <FilterChip
          label="Needs My Signature"
          count={counts.needsSig}
          active={filter === 'needs-sig'}
          onClick={() => setFilter('needs-sig')}
          emphasize={counts.needsSig > 0}
        />
      </nav>

      <div className="space-y-2">
        {loading ? (
          <p className="text-sm opacity-60 italic text-center py-12">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm opacity-60 italic text-center py-12">
            No activity matches this filter.
          </p>
        ) : (
          filtered.map((row, i) => <ActivityRow key={activityKey(row, i)} row={row} />)
        )}
      </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  emphasize,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  emphasize?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md border transition-colors ${
        active
          ? 'bg-safe-green text-safe-dark border-safe-green font-semibold'
          : emphasize
            ? 'border-amber-400/50 text-amber-300 hover:bg-safe-hover'
            : 'border-safe-border opacity-80 hover:bg-safe-hover'
      }`}
    >
      {label}
      <span className="ml-2 opacity-70">({count})</span>
    </button>
  );
}

function ActivityRow({ row }: { row: Row }) {
  if (row.kind === 'incoming') {
    const i = row.incoming;
    return (
      <div className="bg-safe-gray border border-safe-border rounded-xl p-4 flex items-start gap-4">
        <div className="text-2xl shrink-0">↓</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider opacity-70">
              Inbound
            </span>
            <span className="text-xs opacity-60">block {i.blockHeight}</span>
          </div>
          <p className="text-sm font-mono truncate" title={i.fromAddress}>
            from {truncateAddress(i.fromAddress, 10)}
          </p>
          {i.memo && (
            <p className="text-xs opacity-70 mt-1 italic">memo: {i.memo}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-sm text-safe-green">
            +{formatMina(i.amount)} MINA
          </p>
          <p className="text-xs opacity-50 mt-1">
            {new Date(i.createdAt).toLocaleString()}
          </p>
        </div>
      </div>
    );
  }

  const p = row.proposal;
  const label = p.txType ? TX_TYPE_LABELS[p.txType] : 'Unknown';
  const statusColor =
    p.status === 'pending'
      ? 'text-amber-300'
      : p.status === 'executed'
        ? 'text-safe-green'
        : 'opacity-60';
  return (
    <Link
      href={`/transactions/${p.proposalHash}`}
      className="bg-safe-gray border border-safe-border rounded-xl p-4 flex items-start gap-4 hover:border-safe-green transition-colors block"
    >
      <div className="text-2xl shrink-0">↑</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider opacity-70">
            {label}
          </span>
          <span className={`text-xs ${statusColor}`}>{p.status}</span>
          {row.isExpired && (
            <span className="text-[10px] bg-red-500/20 text-red-300 border border-red-400/30 rounded px-1.5 py-0.5 font-semibold">
              Expired
            </span>
          )}
          {row.needsMySig && !row.isExpired && (
            <span className="text-[10px] bg-amber-400/20 text-amber-300 border border-amber-400/30 rounded px-1.5 py-0.5">
              Needs your signature
            </span>
          )}
        </div>
        {p.receivers.length > 0 && (
          <p
            className="text-sm font-mono truncate mt-1"
            title={p.receivers[0].address ?? ''}
          >
            to {truncateAddress(p.receivers[0].address ?? '', 10)}
            {p.receivers.length > 1 && ` +${p.receivers.length - 1} more`}
          </p>
        )}
        <p className="text-xs opacity-60 mt-1">
          {p.approvalCount} approvals
          {p.createdAtBlock != null && ` · block ${p.createdAtBlock}`}
        </p>
      </div>
      <div className="text-right shrink-0">
        {p.totalAmount && p.totalAmount !== '0' && (
          <p className="font-mono text-sm">
            {formatMina(p.totalAmount)} MINA
          </p>
        )}
        <p className="text-xs opacity-50 mt-1">
          {new Date(p.createdAt).toLocaleString()}
        </p>
      </div>
    </Link>
  );
}

function activityKey(row: Row, fallbackIndex: number): string {
  if (row.kind === 'incoming') return `i-${row.incoming.id}`;
  return `p-${row.proposal.proposalHash || fallbackIndex}`;
}
