/**
 * Polls GET /stats to drive the top-bar status dot (live / offline, store
 * backend, Memories.ai mode) and the Refund Desk pending badge while the
 * desk itself is not open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendStatus } from '../types';
import { fetchStatus } from '../api';

export interface BackendStatusHandle extends BackendStatus {
  /** True until the first probe has answered. */
  checking: boolean;
  refresh: () => Promise<void>;
}

export function useBackendStatus(intervalMs = 10_000, enabled = true): BackendStatusHandle {
  const [status, setStatus] = useState<BackendStatus>({ online: false });
  const [checking, setChecking] = useState(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetchStatus();
      setStatus(next);
      setChecking(false);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { ...status, checking, refresh };
}
