'use client';

import { MAX_OWNERS, MAX_RECEIVERS } from '@/lib/constants';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchBalance,
  fetchIndexerStatus,
  fetchRecipientAliases,
  type RecipientAliasRecord,
} from '@/lib/api';
import {
  formatMina,
  nextAvailableNonce,
  truncateAddress,
  NewProposalInput,
  TxType,
  EMPTY_PUBKEY_B58,
  type ContractSummary,
  type Proposal,
} from '@/lib/types';
import TransactionCard from '@/components/TransactionCard';

// Lightnet block time ~30s; devnet ~3min. We bias toward lightnet for
// setup-wizard defaults — 20k blocks ≈ 7 days on lightnet, ≈ 42 days on
// devnet. The operator can always override, and 0 is explicit "never
// expires" — the goal here is just to pick a non-zero default so pending
// proposals don't sit indefinitely (see self-custody spec §4.1).
const DEFAULT_EXPIRY_WINDOW_BLOCKS = 20_000;
const SECONDS_PER_BLOCK = 30;

interface ProposalFormProps {
  owners: string[];
  currentThreshold: number;
  numOwners: number;
  onSubmit: (data: NewProposalInput) => void;
  isSubmitting: boolean;
  txType: TxType;
  /** Indexed subaccounts of this guard, used as targets for CHILD_TX_TYPES. */
  children?: ContractSummary[];
  /** Guard address — used to fetch per-contract aliases for the transfer picker. */
  contractAddress?: string;
  /** Delete-mode only: target's nonce from URL params. Ignored otherwise;
   *  the form derives the default nonce from the active txType's nonce space. */
  initialNonce: number | null;
  /** Parent guard's current executed LOCAL nonce. Only applies to LOCAL
   *  txTypes; REMOTE txTypes read the selected child's parentNonce instead. */
  currentNonce: number | null;
  /** All known proposals on this guard. Used to compute per-nonce-space
   *  collision warnings and next-available defaults. */
  proposals: ReadonlyArray<Proposal>;
  nonceResetKey: string;
  deleteMode?: boolean;
  deleteTargetHash?: string | null;
  deleteTargetProposal?: Proposal | null;
  onExitDeleteMode?: () => void;
}

/** Dynamic proposal form that maps UI inputs to MinaGuard tx type payloads. */
export default function ProposalForm({
  owners,
  currentThreshold,
  numOwners,
  onSubmit,
  isSubmitting,
  txType,
  children = [],
  contractAddress,
  initialNonce,
  currentNonce,
  proposals,
  nonceResetKey,
  deleteMode = false,
  deleteTargetHash = null,
  deleteTargetProposal = null,
  onExitDeleteMode,
}: ProposalFormProps) {
  const [transferLines, setTransferLines] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [removeOwnerAddress, setRemoveOwnerAddress] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [memo, setMemo] = useState('');
  const memoByteLength = new TextEncoder().encode(memo).length;
  // Confirmation modal payload. Populated by handleSubmit after validation
  // passes; operator reviews before we actually hand off to the parent's
  // onSubmit (which in the backend-proving + user-pays path fires the Auro
  // prompt). Prevents accidental double-clicks and mis-typed destinations
  // from firing a signing prompt.
  const [pendingSubmit, setPendingSubmit] = useState<NewProposalInput | null>(null);
  const [aliases, setAliases] = useState<RecipientAliasRecord[]>([]);
  useEffect(() => {
    if (!contractAddress) return;
    let cancelled = false;
    void fetchRecipientAliases(contractAddress).then((rows) => {
      if (!cancelled) setAliases(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [contractAddress]);
  const [newThreshold, setNewThreshold] = useState(Math.max(1, currentThreshold));
  useEffect(() => {
    setNewThreshold(Math.max(1, currentThreshold));
  }, [currentThreshold]);
  const [delegate, setDelegate] = useState('');
  const [undelegate, setUndelegate] = useState(false);
  const [expiryBlock, setExpiryBlock] = useState('');
  const [currentHeight, setCurrentHeight] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchIndexerStatus().then((s) => {
      if (cancelled) return;
      const h = s?.latestChainHeight ?? 0;
      if (h > 0) {
        setCurrentHeight(h);
        if (expiryBlock === '') {
          setExpiryBlock(String(h + DEFAULT_EXPIRY_WINDOW_BLOCKS));
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // Only seed once on first indexer read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const expiryBlockNum = Number(expiryBlock);
  const expiryIsValid = expiryBlock === '' || (Number.isFinite(expiryBlockNum) && expiryBlockNum >= 0);
  const expiryBlocksFromNow =
    currentHeight !== null && expiryBlockNum > currentHeight
      ? expiryBlockNum - currentHeight
      : 0;
  const expiryDays = (expiryBlocksFromNow * SECONDS_PER_BLOCK) / 86_400;

  useEffect(() => {
    if (!deleteMode) return;
    setTransferLines('');
    setExpiryBlock('0');
  }, [deleteMode]);

  // Subaccount-action fields.
  const [targetChild, setTargetChild] = useState<string>('');
  const [reclaimAmount, setReclaimAmount] = useState('');
  const [destroyConfirm, setDestroyConfirm] = useState(false);

  useEffect(() => {
    if (!targetChild && children.length > 0) setTargetChild(children[0].address);
  }, [children, targetChild]);

  // For enableChildMultiSig: derive the target state as the opposite of the
  // selected child's current `childMultiSigEnabled`. Treat null as enabled
  // (SetupEvent initializes the field to true).
  const selectedChild = children.find((c) => c.address === targetChild) ?? null;
  const currentMultiSigEnabled = selectedChild?.childMultiSigEnabled !== false;
  const enableTarget: 'enable' | 'disable' = currentMultiSigEnabled ? 'disable' : 'enable';

  // Delete-mode shape: LOCAL target → zero-value transfer; REMOTE target →
  // zero-amount reclaim.
  const isRemoteDelete = deleteMode && deleteTargetProposal?.destination === 'remote';
  const effectiveTxType: TxType = deleteMode
    ? (isRemoteDelete ? 'reclaimChild' : 'transfer')
    : txType;

  // LOCAL vs REMOTE nonce space. REMOTE non-create proposals use the target
  // child's `parentNonce` counter; LOCAL proposals use the parent guard's
  // `nonce` counter. createChild uses nonce=0 sentinel (not offered here).
  const isRemoteSpaceTxType =
    effectiveTxType === 'reclaimChild' ||
    effectiveTxType === 'destroyChild' ||
    effectiveTxType === 'enableChildMultiSig';

  // For delete-remote the target child comes from the target proposal (the
  // form's own targetChild dropdown isn't surfaced in delete mode).
  const nonceSpaceChildAddress = isRemoteDelete
    ? (deleteTargetProposal?.childAccount ?? null)
    : (isRemoteSpaceTxType ? targetChild || null : null);
  const nonceSpaceChild = nonceSpaceChildAddress
    ? (children.find((c) => c.address === nonceSpaceChildAddress) ?? null)
    : null;

  const effectiveNonceFloor = isRemoteSpaceTxType
    ? (nonceSpaceChild?.parentNonce ?? null)
    : currentNonce;

  const effectiveSpaceProposals = useMemo(() => {
    if (isRemoteSpaceTxType) {
      return proposals.filter(
        (p) => p.destination === 'remote' && p.childAccount === nonceSpaceChildAddress,
      );
    }
    return proposals.filter((p) => p.destination === 'local');
  }, [proposals, isRemoteSpaceTxType, nonceSpaceChildAddress]);

  const effectiveTakenNonces = useMemo(
    () =>
      new Set(
        effectiveSpaceProposals
          .filter((p) => p.status === 'pending')
          .map((p) => Number(p.nonce))
          .filter((n) => Number.isFinite(n)),
      ),
    [effectiveSpaceProposals],
  );

  const effectiveDefaultNonce = useMemo(() => {
    if (deleteMode) return initialNonce;
    return nextAvailableNonce(effectiveNonceFloor, effectiveSpaceProposals);
  }, [deleteMode, initialNonce, effectiveNonceFloor, effectiveSpaceProposals]);

  const [nonce, setNonce] = useState(
    effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce),
  );
  const [nonceDirty, setNonceDirty] = useState(false);

  useEffect(() => {
    setNonceDirty(false);
    setNonce(effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce));
  }, [effectiveDefaultNonce, nonceResetKey]);

  useEffect(() => {
    if (nonceDirty) return;
    setNonce(effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce));
  }, [effectiveDefaultNonce, nonceDirty]);

  // Fetch the selected child's balance so the reclaim form can show the upper bound.
  const [targetBalance, setTargetBalance] = useState<string | null>(null);
  useEffect(() => {
    if (txType !== 'reclaimChild' || !targetChild) {
      setTargetBalance(null);
      return;
    }
    let cancelled = false;
    setTargetBalance(null);
    fetchBalance(targetChild).then((b) => {
      if (!cancelled) setTargetBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [txType, targetChild]);

  const [validationError, setValidationError] = useState<string | null>(null);
  const transferParse = parseTransferLines(transferLines);
  // Live warning for nonce collisions with pending proposals — non-blocking,
  // matches the delete-mode race-to-execute semantics.
  const nonceCollisionWarning = (() => {
    if (deleteMode) return null;
    const parsed = parseProposalNonce(nonce);
    if (parsed === null) return null;
    if (!effectiveTakenNonces.has(parsed)) return null;
    return parsed;
  })();

  /** Emits normalized form payload according to the selected transaction type. */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const parsedNonce = parseProposalNonce(nonce);
    if (parsedNonce === null) {
      setValidationError('Nonce must be a positive integer.');
      return;
    }
    // Skip the executed-nonce floor in delete mode: the target proposal's
    // nonce is authoritative. Otherwise the floor depends on txType's nonce
    // space (parent's localNonce for LOCAL, child's parentNonce for REMOTE).
    if (!deleteMode && effectiveNonceFloor !== null && parsedNonce <= effectiveNonceFloor) {
      const floorLabel = isRemoteSpaceTxType
        ? `the selected subaccount's executed remote nonce (${effectiveNonceFloor})`
        : `the current executed nonce (${effectiveNonceFloor})`;
      setValidationError(`Nonce must be greater than ${floorLabel}.`);
      return;
    }
    // Nonce collision with a pending proposal is deliberately allowed — it's
    // the same mechanism as delete-mode (whichever executes first burns the
    // slot and invalidates the other). A non-blocking warning is rendered
    // below the form instead.

    if (effectiveTxType === 'addOwner' && numOwners >= MAX_OWNERS) {
      setValidationError(`Cannot exceed the maximum of ${MAX_OWNERS} owners.`);
      return;
    }
    if (!deleteMode && (txType === 'transfer' || txType === 'allocateChild') && !transferParse.ok) {
      setValidationError(transferParse.error);
      return;
    }
    if (
      !deleteMode &&
      (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig') &&
      !targetChild
    ) {
      setValidationError('Pick a subaccount to target.');
      return;
    }
    if (!deleteMode && txType === 'reclaimChild') {
      const nano = parseMinaToNanomina(reclaimAmount);
      if (!nano) {
        setValidationError('Reclaim amount must be a positive MINA value.');
        return;
      }
      if (targetBalance !== null && BigInt(nano) > BigInt(targetBalance)) {
        setValidationError(`Reclaim amount exceeds subaccount balance (${formatMina(targetBalance)} MINA).`);
        return;
      }
    }
    if (!deleteMode && txType === 'destroyChild' && !destroyConfirm) {
      setValidationError('Confirm the destroy action — this drains the subaccount and disables its multi-sig.');
      return;
    }
    if (effectiveTxType === 'addOwner' && owners.includes(newOwner.trim())) {
      setValidationError('This address is already an owner.');
      return;
    }
    if (effectiveTxType === 'removeOwner' && !owners.includes(removeOwnerAddress.trim())) {
      setValidationError('This address is not a current owner.');
      return;
    }
    if (effectiveTxType === 'removeOwner' && numOwners - 1 < currentThreshold) {
      setValidationError('Reduce the threshold first before removing an owner.');
      return;
    }
    if (
      effectiveTxType === 'changeThreshold'
      && (
        !Number.isInteger(newThreshold)
        || newThreshold < 1
        || newThreshold > Math.max(1, numOwners)
      )
    ) {
      setValidationError(`Threshold must be between 1 and ${Math.max(1, numOwners)}.`);
      return;
    }
    if (effectiveTxType === 'changeThreshold' && newThreshold === currentThreshold) {
      setValidationError('The new threshold is the same as the current one.');
      return;
    }
    if (
      (txType === 'addRecipient' || txType === 'removeRecipient')
      && !recipientAddress.trim().match(/^B62[A-Za-z0-9]{40,}$/)
    ) {
      setValidationError('Enter a valid B62… recipient address.');
      return;
    }
    if (memoByteLength > 32) {
      setValidationError(`Memo must be ≤ 32 bytes (currently ${memoByteLength}).`);
      return;
    }

    const deleteReceivers = deleteMode && !isRemoteDelete
      ? [{ address: EMPTY_PUBKEY_B58, amount: '0' }]
      : undefined;

    const payload: NewProposalInput = {
      txType: effectiveTxType,
      nonce: parsedNonce,
      receivers:
        deleteReceivers ??
        (effectiveTxType === 'transfer' || effectiveTxType === 'allocateChild'
          ? transferParse.receivers
          : undefined),
      newOwner: !deleteMode && effectiveTxType === 'addOwner' ? newOwner : undefined,
      removeOwnerAddress: !deleteMode && effectiveTxType === 'removeOwner' ? removeOwnerAddress : undefined,
      recipientAddress:
        !deleteMode && (effectiveTxType === 'addRecipient' || effectiveTxType === 'removeRecipient')
          ? recipientAddress.trim()
          : undefined,
      newThreshold: !deleteMode && effectiveTxType === 'changeThreshold' ? newThreshold : undefined,
      delegate: !deleteMode && effectiveTxType === 'setDelegate' && !undelegate ? delegate : undefined,
      undelegate: !deleteMode && effectiveTxType === 'setDelegate' ? undelegate : undefined,
      childAccount:
        isRemoteDelete && deleteTargetProposal?.childAccount
          ? deleteTargetProposal.childAccount
          : !deleteMode && (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig')
            ? targetChild
            : undefined,
      reclaimAmount:
        isRemoteDelete
          ? '0'
          : !deleteMode && txType === 'reclaimChild'
            ? (parseMinaToNanomina(reclaimAmount) ?? '0')
            : undefined,
      childMultiSigEnable:
        !deleteMode && txType === 'enableChildMultiSig' ? enableTarget === 'enable' : undefined,
      expiryBlock: Number(expiryBlock) > 0 ? Number(expiryBlock) : 0,
      memo: memo.trim() || undefined,
    };
    setPendingSubmit(payload);
  };

  const confirmSubmit = () => {
    if (!pendingSubmit) return;
    const payload = pendingSubmit;
    setPendingSubmit(null);
    onSubmit(payload);
  };
  const cancelConfirm = () => setPendingSubmit(null);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {deleteMode && (
        <div className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-4 py-4 text-sm text-orange-200 space-y-3">
          <div>
            <p className="font-semibold text-orange-100">Delete pending proposal</p>
            <p className="mt-1 opacity-90">
              This creates a zero-effect proposal with the same nonce, so if it executes first it will invalidate the proposal below.
            </p>
          </div>

          {deleteTargetProposal ? (
            <div className="space-y-2">
              <TransactionCard
                proposal={deleteTargetProposal}
                threshold={currentThreshold}
                owners={owners}
              />
              <p className="text-xs opacity-75 font-mono break-all">
                Nonce {deleteTargetProposal.nonce} · Hash {truncateAddress(deleteTargetProposal.proposalHash, 8)}
              </p>
            </div>
          ) : deleteTargetHash && (
            <p className="text-xs opacity-75 font-mono break-all">
              Hash {deleteTargetHash}
            </p>
          )}

          {onExitDeleteMode && (
            <button
              type="button"
              onClick={onExitDeleteMode}
              className="text-sm font-medium text-orange-100 underline underline-offset-4 hover:opacity-80"
            >
              Back to normal proposal
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        <FormInput
          label="Nonce"
          value={nonce}
          onChange={(value) => {
            setNonceDirty(true);
            setNonce(value);
          }}
          placeholder={effectiveDefaultNonce === null ? '1' : String(effectiveDefaultNonce)}
          inputMode="numeric"
          required
        />
        <p className="text-xs text-safe-text">
          {(() => {
            const floorLabel = isRemoteSpaceTxType
              ? 'subaccount’s executed remote nonce'
              : 'contract’s executed nonce';
            if (effectiveNonceFloor === null) {
              return `Use a nonce greater than the ${floorLabel}.`;
            }
            if (effectiveDefaultNonce !== null) {
              return `Next available nonce: ${effectiveDefaultNonce}. Current ${floorLabel}: ${effectiveNonceFloor}.`;
            }
            return `Current ${floorLabel}: ${effectiveNonceFloor}. Use a higher nonce for new proposals.`;
          })()}
        </p>
      </div>

      {!deleteMode && (txType === 'transfer' || txType === 'allocateChild') && (
        <div className="space-y-3">
          <label className="block text-sm text-safe-text">
            {txType === 'allocateChild' ? 'Subaccount allocations' : 'Recipients'}
          </label>
          {txType === 'transfer' && (
            <div className="space-y-1">
              <label className="block text-xs text-safe-text">
                Destination{' '}
                <span className="opacity-60">(populates first recipient line)</span>
              </label>
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  // "other" just drops focus into the textarea.
                  if (v === 'other') {
                    e.target.value = '';
                    return;
                  }
                  const alias = aliases.find((a) => a.id === Number(v));
                  if (!alias) return;
                  const line = `${alias.address},`;
                  const next = transferLines.trim()
                    ? `${transferLines.trim()}\n${line}`
                    : line;
                  setTransferLines(next);
                  e.target.value = '';
                }}
                className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-safe-green"
              >
                <option value="">
                  {aliases.length > 0
                    ? 'Pick a saved destination…'
                    : 'No saved destinations — pick Other'}
                </option>
                {aliases.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.alias} — {a.address.slice(0, 10)}…{a.address.slice(-6)}
                  </option>
                ))}
                <option value="other">Other (enter address manually below)</option>
              </select>
            </div>
          )}
          {txType === 'allocateChild' && children.length > 0 && (
            <div className="rounded-lg border border-safe-border bg-safe-dark/20 px-3 py-2 text-xs space-y-1">
              <p className="text-safe-text">Indexed subaccounts (click to copy):</p>
              <ul className="space-y-0.5">
                {children.map((c) => (
                  <li key={c.address}>
                    <button
                      type="button"
                      onClick={() => {
                        const next = transferLines.trim()
                          ? `${transferLines.trim()}\n${c.address},`
                          : `${c.address},`;
                        setTransferLines(next);
                      }}
                      className="font-mono text-safe-green hover:underline truncate"
                      title={c.address}
                    >
                      {c.address.slice(0, 12)}…{c.address.slice(-6)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <textarea
            value={transferLines}
            onChange={(e) => setTransferLines(e.target.value)}
            placeholder={`B62q...,1.25\nB62q...,0.5`}
            rows={8}
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
            required
          />
          <div className="rounded-lg border border-safe-border bg-safe-dark/20 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-safe-text">Parsed recipients</span>
              <span className="font-mono text-safe-green">
                {transferParse.recipientCount}/{MAX_RECEIVERS}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 mt-2">
              <span className="text-safe-text">Total MINA</span>
              <span className="font-mono text-safe-green">
                {formatNanominaAsMina(transferParse.totalAmount)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 mt-2">
              <span className="text-safe-text">Remaining slots</span>
              <span className="font-mono text-safe-text">
                {Math.max(0, MAX_RECEIVERS - transferParse.recipientCount)}
              </span>
            </div>
          </div>
          <p className="text-xs text-safe-text">
            Enter one recipient per line as <span className="font-mono">address,amount</span>.
          </p>
          {!transferParse.ok && transferLines.trim() && (
            <p className="text-sm text-red-400 whitespace-pre-wrap">{transferParse.error}</p>
          )}
        </div>
      )}

      {!deleteMode && (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig') && (
        <div>
          <label className="block text-sm text-safe-text mb-2">Target Subaccount</label>
          {children.length === 0 ? (
            <p className="text-sm text-amber-400">
              No indexed subaccounts to target. Create one first via the parent &rarr; Create Subaccount flow.
            </p>
          ) : (
            <div className="space-y-2">
              {children.map((c) => {
                const selected = targetChild === c.address;
                const accentBorder = txType === 'destroyChild' ? 'border-red-400' : 'border-safe-green';
                const accentBg = txType === 'destroyChild' ? 'bg-red-400/5' : 'bg-safe-green/5';
                const accentDot = txType === 'destroyChild' ? 'bg-red-400' : 'bg-safe-green';
                return (
                  <label
                    key={c.address}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected ? `${accentBorder} ${accentBg}` : 'border-safe-border hover:border-safe-text'
                    }`}
                  >
                    <input
                      type="radio"
                      name="targetChild"
                      value={c.address}
                      checked={selected}
                      onChange={(e) => setTargetChild(e.target.value)}
                      className="sr-only"
                    />
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        selected ? accentBorder : 'border-safe-border'
                      }`}
                    >
                      {selected && <div className={`w-2 h-2 rounded-full ${accentDot}`} />}
                    </div>
                    <span className="text-sm font-mono text-safe-text truncate">{c.address}</span>
                    {c.childMultiSigEnabled === false && (
                      <span className="ml-auto text-[10px] text-amber-400 shrink-0">multi-sig off</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!deleteMode && txType === 'reclaimChild' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-safe-text">Reclaim Amount (MINA)</label>
            <span className="text-xs text-safe-text">
              Available:{' '}
              <span className="font-mono text-safe-green">
                {targetBalance === null ? '…' : `${formatMina(targetBalance)} MINA`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={reclaimAmount}
              onChange={(e) => setReclaimAmount(e.target.value)}
              placeholder="1.0"
              inputMode="decimal"
              required
              className="flex-1 bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
            />
            <button
              type="button"
              disabled={!targetBalance || targetBalance === '0'}
              onClick={() => {
                if (targetBalance) setReclaimAmount(formatMina(targetBalance));
              }}
              className="text-xs font-semibold uppercase tracking-wider text-safe-green hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline px-2"
            >
              Max
            </button>
          </div>
        </div>
      )}

      {!deleteMode && txType === 'destroyChild' && (
        <div className="space-y-2 rounded-lg border border-red-400/40 bg-red-400/5 px-4 py-3">
          <p className="text-xs text-red-300">
            Destroy drains the subaccount&apos;s full balance to the parent and disables its
            multi-sig. The on-chain account remains but its lifecycle is permanently frozen.
          </p>
          <label className="inline-flex items-center gap-2 text-sm text-safe-text">
            <input
              type="checkbox"
              checked={destroyConfirm}
              onChange={(e) => setDestroyConfirm(e.target.checked)}
            />
            I understand and want to destroy this subaccount.
          </label>
        </div>
      )}

      {!deleteMode && txType === 'enableChildMultiSig' && selectedChild && (
        <div className="space-y-2 rounded-lg border border-safe-border bg-safe-dark/20 px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-safe-text">Current state</span>
            <span className={`font-semibold ${currentMultiSigEnabled ? 'text-safe-green' : 'text-amber-400'}`}>
              {currentMultiSigEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-safe-text">Proposed state</span>
            <span className={`font-semibold ${enableTarget === 'enable' ? 'text-safe-green' : 'text-amber-400'}`}>
              {enableTarget === 'enable' ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p className="text-xs text-safe-text pt-1">
            {currentMultiSigEnabled
              ? 'Disabling blocks the subaccount from running its own LOCAL proposals (transfers, owner changes, etc.). Parent-authorized lifecycle actions remain available.'
              : 'Enabling restores the subaccount\'s ability to run its own LOCAL proposals.'}
          </p>
        </div>
      )}

      {effectiveTxType === 'addOwner' && (
        <FormInput
          label="New Owner Address"
          value={newOwner}
          onChange={setNewOwner}
          placeholder="B62q..."
          mono
          required
        />
      )}

      {(effectiveTxType === 'addRecipient' || effectiveTxType === 'removeRecipient') && (
        <div className="space-y-2">
          <FormInput
            label={effectiveTxType === 'addRecipient' ? 'Recipient to add to allowlist' : 'Recipient to remove from allowlist'}
            value={recipientAddress}
            onChange={setRecipientAddress}
            placeholder="B62q..."
            mono
            required
          />
          <p className="text-xs text-safe-text opacity-70">
            {effectiveTxType === 'addRecipient'
              ? 'Once approved, executeTransfer will accept this address as a destination. ADD fails if already present.'
              : 'Once approved, executeTransfer will reject this address. REMOVE fails if the address is not currently allowed.'}
          </p>
        </div>
      )}

      {effectiveTxType === 'removeOwner' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">Select Owner to Remove</label>
          <div className="space-y-2">
            {owners.map((owner) => (
              <label
                key={owner}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${removeOwnerAddress === owner
                  ? 'border-red-400 bg-red-400/5'
                  : 'border-safe-border hover:border-safe-text'
                  }`}
              >
                <input
                  type="radio"
                  name="removeOwner"
                  value={owner}
                  checked={removeOwnerAddress === owner}
                  onChange={(e) => setRemoveOwnerAddress(e.target.value)}
                  className="sr-only"
                />
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeOwnerAddress === owner ? 'border-red-400' : 'border-safe-border'
                    }`}
                >
                  {removeOwnerAddress === owner && <div className="w-2 h-2 rounded-full bg-red-400" />}
                </div>
                <span className="text-sm font-mono text-safe-text">{owner}</span>
              </label>
            ))}
          </div>
          {numOwners - 1 < currentThreshold && (
            <p className="text-xs text-red-400 mt-2">
              Cannot remove an owner while it would go below the threshold. Create a &quot;Change Threshold&quot; proposal first.
            </p>
          )}
        </div>
      )}

      {effectiveTxType === 'changeThreshold' && (
        <div>
          <label className="text-sm text-safe-text mb-2 flex items-center gap-1">
            New Threshold
            <span className="relative group">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-safe-border text-[10px] leading-none text-safe-text cursor-help">?</span>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 transition-all duration-200 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0">
                <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-2.5 py-1 shadow-lg whitespace-nowrap">
                  Minimum approvals required to execute a proposal.
                </div>
                <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
                  <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
                </svg>
              </div>
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={Math.max(1, numOwners)}
              value={newThreshold}
              onChange={(e) => {
                const value = e.currentTarget.valueAsNumber;
                if (Number.isNaN(value)) return;
                setNewThreshold(value);
              }}
              className="w-20 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm"
            />
            <span className="text-sm text-safe-text">out of {numOwners}</span>
          </div>
        </div>
      )}

      {effectiveTxType === 'setDelegate' && (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-sm text-safe-text">
            <input
              type="checkbox"
              checked={undelegate}
              onChange={(e) => setUndelegate(e.target.checked)}
            />
            Undelegate (set delegate to contract self)
          </label>
          {!undelegate && (
            <FormInput
              label="Delegate Address"
              value={delegate}
              onChange={setDelegate}
              placeholder="B62q..."
              mono
              required
            />
          )}
        </div>
      )}

      <div className="space-y-1">
        <label className="block text-sm text-safe-text">
          Expires at block{' '}
          <span className="opacity-60">(0 = never expires)</span>
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={expiryBlock}
          onChange={(e) => setExpiryBlock(e.target.value)}
          placeholder="0"
          className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:border-safe-green"
        />
        <div className="flex justify-between items-center text-xs text-safe-text opacity-70">
          <span>
            {currentHeight !== null
              ? `Current block: ${currentHeight.toLocaleString()}`
              : 'Loading current block height…'}
          </span>
          <span className={!expiryIsValid ? 'text-red-400' : ''}>
            {!expiryIsValid
              ? 'Invalid block number'
              : expiryBlockNum === 0 || expiryBlock === ''
                ? 'never expires'
                : currentHeight !== null && expiryBlockNum <= currentHeight
                  ? 'ALREADY EXPIRED — propose will revert'
                  : `expires in ${expiryBlocksFromNow.toLocaleString()} blocks (≈${expiryDays.toFixed(1)} days)`}
          </span>
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-safe-text">
          Memo <span className="opacity-60">(optional, included on the propose tx)</span>
        </label>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="e.g. bi-weekly rebalance to kraken"
          className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green"
        />
        <div className="flex justify-between text-xs text-safe-text opacity-70">
          <span>Will be included with the transfer for exchange identification.</span>
          <span className={memoByteLength > 32 ? 'text-red-400' : ''}>
            {memoByteLength}/32 characters
          </span>
        </div>
      </div>

      {nonceCollisionWarning && (
        <div className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-4 py-3 text-sm text-orange-200">
          <p className="font-semibold mb-1">Nonce {nonceCollisionWarning} is already in use</p>
          <p className="opacity-90">
            Another pending proposal is queued at this nonce. Submitting will race it — whichever
            executes first burns the nonce and invalidates the other. This is the same mechanism as
            delete-mode.
          </p>
        </div>
      )}

      {validationError && <p className="text-sm text-red-400">{validationError}</p>}

      <div className="bg-safe-dark/30 border border-safe-border rounded-lg px-4 py-3 text-xs opacity-80">
        This request will require <span className="font-semibold text-safe-green">{currentThreshold}</span> {currentThreshold === 1 ? 'approval' : 'approvals'} before execution.
        {currentThreshold >= 2 && (
          <> Separation of duties: the proposer&apos;s signature does not count as an approval.</>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting Proposal...' : (deleteMode ? 'Create Delete Proposal' : 'Review & Submit Proposal')}
      </button>

      {pendingSubmit && (
        <ConfirmActionModal
          payload={pendingSubmit}
          currentThreshold={currentThreshold}
          onConfirm={confirmSubmit}
          onCancel={cancelConfirm}
          isSubmitting={isSubmitting}
        />
      )}
    </form>
  );
}

/**
 * Review modal shown between Submit click and Auro prompt. Gives the
 * operator a last look at destination / amount / memo before signing.
 * Mockup §"Confirm Action" — protects against typos + double-clicks.
 */
function ConfirmActionModal({
  payload,
  currentThreshold,
  onConfirm,
  onCancel,
  isSubmitting,
}: {
  payload: NewProposalInput;
  currentThreshold: number;
  onConfirm: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
}) {
  const kindLabel: Record<string, string> = {
    transfer: 'Transfer',
    addOwner: 'Add Owner',
    removeOwner: 'Remove Owner',
    changeThreshold: 'Change Threshold',
    setDelegate: 'Set Delegate',
    allocateChild: 'Allocate to Subaccounts',
    reclaimChild: 'Reclaim from Subaccount',
    destroyChild: 'Destroy Subaccount',
    enableChildMultiSig: 'Toggle Subaccount Multi-sig',
    addRecipient: 'Add Allowed Recipient',
    removeRecipient: 'Remove Allowed Recipient',
    createChild: 'Create Subaccount',
  };
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-safe-dark border border-safe-border rounded-xl p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Confirm action</h2>
        <p className="text-sm opacity-80">
          Review this proposal before it&apos;s submitted to the chain.
          Your Auro wallet will be asked to sign and pay the fee.
        </p>

        <dl className="space-y-2 text-sm">
          <Row label="Type" value={kindLabel[payload.txType] ?? payload.txType} />
          {payload.receivers && payload.receivers.length > 0 && (
            <>
              <Row label="Recipients" value={String(payload.receivers.length)} />
              <Row
                label="First recipient"
                value={payload.receivers[0].address}
                mono
              />
              <Row
                label="Total MINA"
                value={payload.receivers
                  .reduce((n, r) => n + BigInt(r.amount), 0n)
                  .toString()}
              />
            </>
          )}
          {payload.newOwner && <Row label="New owner" value={payload.newOwner} mono />}
          {payload.removeOwnerAddress && (
            <Row label="Remove owner" value={payload.removeOwnerAddress} mono />
          )}
          {payload.newThreshold !== undefined && (
            <Row label="New threshold" value={String(payload.newThreshold)} />
          )}
          {payload.delegate && <Row label="Delegate" value={payload.delegate} mono />}
          {payload.undelegate && <Row label="Undelegate" value="yes (point stake to self)" />}
          {payload.recipientAddress && (
            <Row label="Recipient" value={payload.recipientAddress} mono />
          )}
          {payload.childAccount && (
            <Row label="Subaccount" value={payload.childAccount} mono />
          )}
          {payload.reclaimAmount && (
            <Row label="Reclaim amount (nanomina)" value={payload.reclaimAmount} />
          )}
          {payload.memo && <Row label="Memo" value={payload.memo} />}
          {payload.expiryBlock !== undefined && payload.expiryBlock > 0 && (
            <Row label="Expires at block" value={String(payload.expiryBlock)} />
          )}
        </dl>

        <div className="bg-safe-dark/30 border border-safe-border rounded-lg px-3 py-2 text-xs opacity-80">
          This request will require <span className="font-semibold text-safe-green">{currentThreshold}</span> {currentThreshold === 1 ? 'approval' : 'approvals'} before execution.
        </div>

        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="border border-safe-border rounded-lg px-4 py-2 text-sm hover:bg-safe-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110 disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting…' : 'Confirm & Sign'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-3">
      <dt className="text-xs uppercase tracking-wider opacity-70 shrink-0">{label}</dt>
      <dd
        className={`text-xs text-right break-all ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

type TransferParseResult =
  | {
    ok: true;
    receivers: Array<{ address: string; amount: string }>;
    recipientCount: number;
    totalAmount: string;
  }
  | {
    ok: false;
    receivers: Array<{ address: string; amount: string }>;
    recipientCount: number;
    totalAmount: string;
    error: string;
  };

function parseTransferLines(input: string): TransferParseResult {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      ok: false,
      receivers: [],
      recipientCount: 0,
      totalAmount: '0',
      error: 'Add at least one recipient line.',
    };
  }

  if (lines.length > MAX_RECEIVERS) {
    return {
      ok: false,
      receivers: [],
      recipientCount: lines.length,
      totalAmount: '0',
      error: `Too many recipients. The contract limit is ${MAX_RECEIVERS}.`,
    };
  }

  const receivers: Array<{ address: string; amount: string }> = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let total = 0n;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const parts = line.split(',');
    if (parts.length !== 2) {
      errors.push(`Line ${index + 1}: expected "address,amount"`);
      continue;
    }

    const address = parts[0].trim();
    const amountText = parts[1].trim();
    if (!/^B62[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      errors.push(`Line ${index + 1}: invalid Mina address`);
      continue;
    }

    if (seen.has(address)) {
      errors.push(`Line ${index + 1}: duplicate recipient`);
      continue;
    }

    const amount = parseMinaToNanomina(amountText);
    if (!amount) {
      errors.push(`Line ${index + 1}: invalid amount`);
      continue;
    }

    seen.add(address);
    receivers.push({ address, amount });
    total += BigInt(amount);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      receivers,
      recipientCount: receivers.length,
      totalAmount: total.toString(),
      error: errors.join('\n'),
    };
  }

  return {
    ok: true,
    receivers,
    recipientCount: receivers.length,
    totalAmount: total.toString(),
  };
}

function parseMinaToNanomina(value: string): string | null {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const fracPadded = frac.padEnd(9, '0');
  const amount = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '') || '0';
  return BigInt(amount) > 0n ? amount : null;
}

function formatNanominaAsMina(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, '') || '0';
  const whole = normalized.length > 9 ? normalized.slice(0, -9) : '0';
  const frac = normalized.length > 9 ? normalized.slice(-9) : normalized.padStart(9, '0');
  const trimmedFrac = frac.replace(/0+$/, '');
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
}

function parseProposalNonce(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Shared text input primitive for proposal form field sections. */
function FormInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  mono,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  mono?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  return (
    <div>
      <label className="block text-sm text-safe-text mb-2">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={`w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors ${mono ? 'font-mono' : ''
          }`}
        required={required}
      />
    </div>
  );
}
