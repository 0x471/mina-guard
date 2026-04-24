/**
 * Block-explorer URL builders. The active network's base URL comes from
 * `NEXT_PUBLIC_BLOCK_EXPLORER_URL` (local lightnet explorer on
 * :5001, minascan devnet/mainnet, custom self-hosted, etc.).
 *
 * Minascan paths: `/tx/<hash>`, `/account/<pk>`. Local lightnet explorer
 * follows the same convention. If a network uses a different path scheme,
 * this helper can be extended with per-network formatters.
 */

function base(): string | null {
  const raw = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function explorerTxUrl(txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  const b = base();
  if (!b) return null;
  return `${b}/tx/${txHash}`;
}

export function explorerAccountUrl(address: string | null | undefined): string | null {
  if (!address) return null;
  const b = base();
  if (!b) return null;
  return `${b}/account/${address}`;
}

export function explorerBlockUrl(blockHeight: number | null | undefined): string | null {
  if (blockHeight == null) return null;
  const b = base();
  if (!b) return null;
  return `${b}/block/${blockHeight}`;
}
