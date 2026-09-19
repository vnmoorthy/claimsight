/**
 * Stats — EdgeOne Makers Node Function
 * ====================================
 *
 * File path cloud-functions/stats/index.ts maps to **GET /stats**.
 *
 * Returns `counters` + the last 20 claims, plus the derived numbers the UI stats strip shows
 * (auto-approval %, refunded $, fraud flags, median / p95 latency). VeloDB is optional on top.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import { isArchiveEnabled } from '../_archive';
import {
  getClaimsStore, resolveEnv, getCounters, listClaims, jsonResponse, errorResponse,
  isMemoriesStubbed, backendLabelFor, round2,
} from '../_kv';

const logger = createLogger('stats');

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  try {
    const store = await getClaimsStore(env);
    const counters = await getCounters(store);
    const all = await listClaims(store);
    const recent = all.slice(0, 20);
    const latencies = all.map(c => Number(c.latency_ms)).filter(n => Number.isFinite(n) && n > 0);
    const decidedByAgent = all.filter(c => c.status === 'auto_approved' || c.status === 'replacement').length;
    const derived = {
      auto_approval_rate: counters.claims > 0 ? round2(counters.auto_approved / counters.claims) : 0,
      auto_approval_pct: counters.claims > 0 ? Math.round((counters.auto_approved / counters.claims) * 100) : 0,
      refunded_total: round2(counters.refunded_total),
      fraud_flags: counters.fraud_flags,
      pending_review: all.filter(c => c.status === 'pending_review').length,
      needs_info: all.filter(c => c.status === 'needs_info').length,
      decided_by_agent: decidedByAgent,
      median_latency_ms: percentile(latencies, 50),
      p95_latency_ms: percentile(latencies, 95),
      claims_total: all.length,
    };
    // Labels for the status strip: which engine made the last decision, and whether this is demo or live data.
    const last = recent[0];
    const backendLabel = backendLabelFor(store.backend, env);
    logger.log(`[stats] claims=${all.length} auto=${counters.auto_approved} pending=${derived.pending_review} backend=${backendLabel}`);
    return jsonResponse({
      counters,
      derived,
      recent,
      mode: last?.mode ?? null,
      mode_label: last?.mode_label ?? null,
      backend: store.backend,
      backend_label: backendLabel,
      archive_enabled: isArchiveEnabled(env),
      memories_stubbed: isMemoriesStubbed(env),
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    logger.error('[stats] failed:', e);
    return errorResponse(500, 'stats_failed', e instanceof Error ? e.message : String(e));
  }
}
