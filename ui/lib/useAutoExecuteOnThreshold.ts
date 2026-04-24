'use client';

import { useEffect, useRef, useState } from 'react';
import type { Proposal } from './types';
import { executeAnyViaBackend } from './multisigClient';

/**
 * Fires the correct `execute*` method once a proposal has reached its
 * threshold of approvals.
 *
 * Safety layering (belt-and-suspenders because we can't be sure only one
 * tab sees the threshold cross):
 *   1. `firedRef` prevents re-firing within a single tab.
 *   2. `localStorage[autoExecute:<hash>]` suppresses duplicate fires across
 *      tabs on the same origin.
 *   3. A 2s debounce lets the backend index the last approval tx before
 *      we proof+submit the execute (state reads need to see it).
 *   4. The contract's EXECUTED_MARKER is the final safety: a second
 *      execute tx for the same proposal fails on-chain benignly.
 *
 * CREATE_CHILD is intentionally excluded — it finalizes via a dedicated
 * deploy+setup atomic flow, not `executeAnyViaBackend`. Other REMOTE
 * child-lifecycle ops (reclaim/destroy/enable) are handled by the
 * unified backend dispatcher.
 */

const DEBOUNCE_MS = 2000;

export interface UseAutoExecuteArgs {
  proposal: Proposal | null | undefined;
  contractAddress: string | null | undefined;
  threshold: number | null | undefined;
  approvalAddresses: string[];
  /** Optional child address for REMOTE child-lifecycle execute dispatch. */
  childAddress?: string;
  /** Value for `enableChildMultiSig` proposals only. */
  childEnabled?: boolean;
  /** Disable auto-execute entirely (e.g. stale config, not an owner). */
  enabled?: boolean;
  /** Connected wallet pubkey — pays the Mina tx fee + signs fee-payer via Auro. */
  feePayer?: string | null;
}

export interface UseAutoExecuteResult {
  autoExecuting: boolean;
  autoError: string | null;
  /** Clears the localStorage + in-memory guards so a manual retry can happen. */
  reset: () => void;
}

export function useAutoExecuteOnThreshold(
  args: UseAutoExecuteArgs,
): UseAutoExecuteResult {
  const {
    proposal,
    contractAddress,
    threshold,
    approvalAddresses,
    childAddress,
    feePayer,
    childEnabled,
    enabled = true,
  } = args;

  const [autoExecuting, setAutoExecuting] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const firedRef = useRef(false);

  const lsKey = proposal ? `autoExecute:${proposal.proposalHash}` : null;

  const reset = () => {
    firedRef.current = false;
    setAutoError(null);
    if (lsKey && typeof window !== 'undefined') {
      window.localStorage.removeItem(lsKey);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    if (!proposal || !contractAddress || !threshold || threshold < 1) return;
    if (proposal.status !== 'pending') return;
    if (proposal.txType === 'createChild') return;
    if (firedRef.current) return;
    if (approvalAddresses.length < threshold) return;
    if (!lsKey) return;

    if (
      typeof window !== 'undefined' &&
      window.localStorage.getItem(lsKey)
    ) {
      // Another tab already fired (or a previous session did without
      // finishing). The contract's EXECUTED_MARKER is the final safety —
      // if that tab's tx never landed, the user can manually execute to
      // clear the stuck state.
      return;
    }

    firedRef.current = true;
    setAutoError(null);

    const handle = window.setTimeout(() => {
      (async () => {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(lsKey, String(Date.now()));
        }
        setAutoExecuting(true);
        try {
          if (!feePayer) {
            throw new Error(
              'Auto-execute requires a connected wallet to pay the fee.',
            );
          }
          await executeAnyViaBackend({
            contractAddress,
            proposal,
            childAddress,
            enabled: childEnabled,
            feePayer,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setAutoError(msg);
          // Clear the LS guard so a manual retry or another tab can try.
          if (typeof window !== 'undefined') {
            window.localStorage.removeItem(lsKey);
          }
          firedRef.current = false;
        } finally {
          setAutoExecuting(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
    // Reacting to approval count change and proposal status means a tab
    // that loads an already-threshold-crossed proposal also auto-executes.
  }, [
    enabled,
    proposal,
    contractAddress,
    threshold,
    approvalAddresses.length,
    childAddress,
    childEnabled,
    feePayer,
    lsKey,
  ]);

  return { autoExecuting, autoError, reset };
}
