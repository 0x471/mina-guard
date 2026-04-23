'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchRecipientAliases,
  createRecipientAlias,
  deleteRecipientAlias,
  type RecipientAliasRecord,
} from '@/lib/api';
import { truncateAddress } from '@/lib/types';

/**
 * UI-layer alias book for recipient addresses ("Kraken" → B62…). Persisted
 * per-contract via the backend's /recipient-aliases routes.
 *
 * Aliases are OPERATOR METADATA only — not enforced on-chain. The
 * recipient-allowlist feature is a separate, on-chain-enforced layer.
 * Aliases just make the Propose Transfer modal + Activity feed readable.
 */
export default function RecipientAliasManager({
  contractAddress,
  walletAddress,
  onPick,
}: {
  contractAddress: string;
  walletAddress: string | null;
  onPick?: (addr: string, alias: string) => void;
}) {
  const [rows, setRows] = useState<RecipientAliasRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftAlias, setDraftAlias] = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchRecipientAliases(contractAddress);
      setRows(next);
    } finally {
      setLoading(false);
    }
  }, [contractAddress]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    setError(null);
    const alias = draftAlias.trim();
    const addr = draftAddress.trim();
    if (!alias) {
      setError('Alias label required.');
      return;
    }
    if (!addr.startsWith('B62') || addr.length < 50) {
      setError('Address must be a valid B62… pubkey.');
      return;
    }
    setSaving(true);
    try {
      const result = await createRecipientAlias(contractAddress, {
        alias,
        address: addr,
        createdBy: walletAddress,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setDraftAlias('');
      setDraftAddress('');
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    setError(null);
    const result = await deleteRecipientAlias(contractAddress, id);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    await reload();
  };

  return (
    <div className="bg-safe-gray border border-safe-border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-safe-text uppercase tracking-wider">
          Address Book
        </p>
        <p className="text-[11px] opacity-60">
          UI-only — not enforced on-chain
        </p>
      </div>

      {loading ? (
        <p className="text-xs opacity-60">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs opacity-60 italic">
          No aliases yet. Add one below — for example, "Kraken" → your Kraken
          deposit address.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 bg-safe-dark/20 border border-safe-border rounded-md px-2.5 py-1.5"
            >
              {onPick ? (
                <button
                  type="button"
                  onClick={() => onPick(r.address, r.alias)}
                  className="text-safe-green hover:underline text-sm font-semibold"
                  title="Insert into proposal"
                >
                  {r.alias}
                </button>
              ) : (
                <span className="text-sm font-semibold">{r.alias}</span>
              )}
              <span
                className="text-xs font-mono opacity-70 truncate flex-1"
                title={r.address}
              >
                {truncateAddress(r.address, 10)}
              </span>
              <button
                type="button"
                onClick={() => remove(r.id)}
                className="text-xs opacity-50 hover:opacity-100 hover:text-red-400"
                title="Delete alias"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-safe-border pt-3 space-y-2">
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <input
            type="text"
            value={draftAlias}
            onChange={(e) => {
              setDraftAlias(e.target.value);
              setError(null);
            }}
            placeholder="Label (e.g. Kraken)"
            className="bg-safe-dark border border-safe-border rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-safe-green"
          />
          <input
            type="text"
            value={draftAddress}
            onChange={(e) => {
              setDraftAddress(e.target.value);
              setError(null);
            }}
            placeholder="B62…"
            className="bg-safe-dark border border-safe-border rounded-md px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-safe-green"
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="button"
          onClick={add}
          disabled={saving}
          className="w-full bg-safe-green text-safe-dark font-semibold rounded-md py-1.5 text-xs hover:brightness-110 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Add alias'}
        </button>
      </div>
    </div>
  );
}
