/**
 * Evidence attachment state machine for the composer.
 *
 *   idle ─attachFile→ uploading ─/upload-evidence→ indexing ─poll /evidence-status (2 s)→ ready
 *        ─useDemo→ ready (no upload; stage fallback)
 *   any  ─clear→ idle
 *
 * The hook owns the upload AbortController and the polling timer, so
 * unmounting or clearing never leaves a stray request behind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DemoEvidence, EvidenceStage, EvidenceState } from '../types';
import { fetchEvidenceStatus, uploadEvidence } from '../api';

export const EVIDENCE_STAGES: readonly EvidenceStage[] = ['preprocess', 'index', 'derive'];

const POLL_INTERVAL_MS = 2000;
/** Consecutive status-poll failures tolerated before giving up (≈ 20 s of backend silence). */
const MAX_POLL_FAILURES = 10;

/** 0–1 or 0–100 → 0–100, clamped. */
export function normalizeProgress(p: number | undefined, done: boolean): number {
  if (done) return 100;
  if (p === undefined || !Number.isFinite(p)) return 0;
  const pct = p <= 1 ? p * 100 : p;
  return Math.max(0, Math.min(99, Math.round(pct)));
}

/** Derive the pipeline stage from the backend's free-form stage string, else from progress. */
export function normalizeStage(stage: string | undefined, progress: number): EvidenceStage {
  const s = (stage ?? '').toLowerCase();
  if (s.includes('deriv') || s.includes('summar') || s.includes('caption')) return 'derive';
  if (s.includes('index') || s.includes('embed')) return 'index';
  if (s.includes('pre') || s.includes('upload') || s.includes('transcod') || s.includes('parse')) return 'preprocess';
  if (progress >= 67) return 'derive';
  if (progress >= 34) return 'index';
  return 'preprocess';
}

export interface UseEvidenceResult {
  evidence: EvidenceState;
  attachFile: (file: File, orderId: string) => void;
  useDemo: (item: DemoEvidence) => void;
  clear: () => void;
}

export function useEvidence(): UseEvidenceResult {
  const [evidence, setEvidence] = useState<EvidenceState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  /** Monotonic token: every attach/clear bumps it so stale polls are ignored. */
  const runRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    runRef.current += 1;
    stopPolling();
    abortRef.current?.abort();
    abortRef.current = null;
    setEvidence({ status: 'idle' });
  }, [stopPolling]);

  const useDemo = useCallback((item: DemoEvidence) => {
    runRef.current += 1;
    stopPolling();
    abortRef.current?.abort();
    abortRef.current = null;
    setEvidence({
      status: 'ready',
      source: 'demo',
      videoId: item.video_id,
      orderId: item.order_id,
      label: item.label,
      summary: item.note,
      progress: 100,
      stage: 'derive',
    });
  }, [stopPolling]);

  const attachFile = useCallback((file: File, orderId: string) => {
    runRef.current += 1;
    const run = runRef.current;
    stopPolling();
    abortRef.current?.abort();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setEvidence({ status: 'uploading', source: 'upload', label: file.name, orderId, progress: 0, stage: 'preprocess' });

    (async () => {
      let videoId = '';
      let operation = '';
      try {
        const res = await uploadEvidence(file, orderId, ctrl.signal);
        videoId = res.video_id;
        operation = res.operation;
      } catch (e) {
        if (run !== runRef.current) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setEvidence({ status: 'error', source: 'upload', label: file.name, orderId, error: (e as Error).message || 'Upload failed' });
        return;
      }
      if (run !== runRef.current) return;

      setEvidence({
        status: 'indexing', source: 'upload', label: file.name, orderId,
        videoId, operation, progress: 0, stage: 'preprocess',
      });

      let failures = 0;
      const tick = async () => {
        if (run !== runRef.current) return;
        try {
          const s = await fetchEvidenceStatus(operation, videoId);
          if (run !== runRef.current) return;
          failures = 0;

          if (s.error) {
            setEvidence(prev => ({ ...prev, status: 'error', error: s.error }));
            return;
          }
          if (s.done) {
            setEvidence(prev => ({
              ...prev,
              status: 'ready',
              progress: 100,
              stage: 'derive',
              summary: s.summary ?? s.caption ?? prev.summary,
            }));
            return;
          }
          const progress = normalizeProgress(s.progress, false);
          setEvidence(prev => ({
            ...prev,
            status: 'indexing',
            // never let the bar move backwards between polls
            progress: Math.max(prev.progress ?? 0, progress),
            stage: normalizeStage(s.stage, Math.max(prev.progress ?? 0, progress)),
          }));
        } catch (e) {
          if (run !== runRef.current) return;
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            setEvidence(prev => ({ ...prev, status: 'error', error: `Lost contact with /evidence-status: ${(e as Error).message}` }));
            return;
          }
        }
        timerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      };

      timerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
    })();
  }, [stopPolling]);

  // Tear down on unmount.
  useEffect(() => () => {
    runRef.current += 1;
    stopPolling();
    abortRef.current?.abort();
  }, [stopPolling]);

  return { evidence, attachFile, useDemo, clear };
}
