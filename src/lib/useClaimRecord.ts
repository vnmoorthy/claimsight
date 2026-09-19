/**
 * Resolve a claim id (from a Decision Card or the live trace) to its stored
 * record so the UI can show what the block alone does not carry: the
 * Memories.ai evidence summary, the damage assessment and the fraud matches
 * with similarity scores. Retries once, because the record may land a beat
 * after the decision event on a slow store.
 */

import { useEffect, useState } from 'react';
import type { ClaimRecord } from '../types';
import { fetchClaimById } from '../api';

export function useClaimRecord(claimId: string | undefined, enabled = true): { record: ClaimRecord | null; loading: boolean } {
  const [record, setRecord] = useState<ClaimRecord | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !claimId) {
      setRecord(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let retry: number | null = null;
    setLoading(true);
    setRecord(null);

    const attempt = async (force: boolean, retriesLeft: number) => {
      const found = await fetchClaimById(claimId, force);
      if (cancelled) return;
      if (found) {
        setRecord(found);
        setLoading(false);
        return;
      }
      if (retriesLeft > 0) {
        retry = window.setTimeout(() => { void attempt(true, retriesLeft - 1); }, 1500);
      } else {
        setLoading(false);
      }
    };
    void attempt(false, 2);

    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
    };
  }, [claimId, enabled]);

  return { record, loading };
}
