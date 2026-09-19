/**
 * Follow a claim's Damage Twin from `queued` to `ready`. Blender takes ~25 s,
 * so while the twin is pending the hook polls GET /claim?claim_id= every 3 s
 * (stopping after 3 minutes or as soon as the render is ready / failed /
 * unavailable) and ticks an elapsed-seconds counter for the placeholder.
 *
 * `source` is whatever the caller already knows (the decision block, the
 * stored record, a desk list item); it is merged with what polling finds so
 * the most advanced status always wins.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClaimRecord, DamageTwin } from '../types';
import { fetchClaim } from '../api';
import { toMillis } from './format';
import { isTwinPending, mergeTwin } from './twin';

export const TWIN_POLL_MS = 3000;
export const TWIN_POLL_MAX_MS = 180_000;

export interface DamageTwinHandle {
  twin: DamageTwin | undefined;
  /** Seconds since the render was requested (or first seen pending). */
  elapsedS: number;
  /** True once polling gave up (3 min) — the twin is then reported as `failed`. */
  timedOut: boolean;
}

export function useDamageTwin(
  claimId: string | undefined,
  source: DamageTwin | undefined,
  onRecord?: (record: ClaimRecord) => void,
): DamageTwinHandle {
  const [polled, setPolled] = useState<DamageTwin | undefined>(undefined);
  const [timedOut, setTimedOut] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const firstSeenRef = useRef<number | null>(null);
  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;

  // A different claim: forget what polling found for the previous one.
  useEffect(() => {
    setPolled(undefined);
    setTimedOut(false);
    firstSeenRef.current = null;
  }, [claimId]);

  const merged = useMemo(() => mergeTwin(source, polled), [source, polled]);
  const pending = isTwinPending(merged);
  const polling = pending && !timedOut && !!claimId;

  useEffect(() => {
    if (!polling || !claimId) return;
    if (firstSeenRef.current === null) firstSeenRef.current = Date.now();
    const begin = firstSeenRef.current;
    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      if (Date.now() - begin > TWIN_POLL_MAX_MS) {
        setTimedOut(true);
        return;
      }
      inFlight = true;
      try {
        const record = await fetchClaim(claimId);
        if (cancelled || !record) return;
        if (record.twin) setPolled(prev => mergeTwin(prev, record.twin));
        onRecordRef.current?.(record);
      } catch {
        // transient — the next tick retries
      } finally {
        inFlight = false;
      }
    };

    const pollId = window.setInterval(() => { void poll(); }, TWIN_POLL_MS);
    const clockId = window.setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      window.clearInterval(clockId);
    };
  }, [polling, claimId]);

  // Elapsed: from the backend's requested_at when it is recent, else from when we first saw it pending.
  let elapsedS = 0;
  if (pending) {
    const requested = toMillis(merged?.requested_at);
    const recent = requested !== undefined && now - requested >= 0 && now - requested < TWIN_POLL_MAX_MS * 2;
    const from = recent ? requested! : (firstSeenRef.current ?? now);
    elapsedS = Math.max(0, Math.floor((now - from) / 1000));
  }

  const twin = pending && timedOut && merged ? { ...merged, status: 'failed' as const, error: merged.error ?? 'timeout' } : merged;
  return { twin, elapsedS, timedOut };
}
