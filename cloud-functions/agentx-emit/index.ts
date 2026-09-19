/**
 * AgentX trace emitter — EdgeOne Makers Node Function
 * ===================================================
 *
 * File path cloud-functions/agentx-emit/index.ts maps to **POST /agentx-emit**.
 *
 * Body `{ claim }` → posts ONE OTLP/HTTP JSON trace to `${AGENTX_OTLP_URL}` (default
 * http://localhost:4700/api/v1/otel/v1/traces) with header `x-api-key: $AGENTX_API_KEY`:
 * a root `agent` span plus one span per tool call (`claim.tool_calls[]`). Silently no-ops
 * (HTTP 200, `emitted: false`) when neither AGENTX_OTLP_URL nor AGENTX_API_KEY is set, or the
 * collector is unreachable. On success the claim record gets `trace: { trace_id, … }` so the
 * UI can show the trace. The agent calls this at the end of every claim.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, getClaim, nowIso,
  type ClaimRecord, type ToolCallTrace,
} from '../_kv';

const logger = createLogger('agentx-emit');

export const DEFAULT_AGENTX_OTLP_URL = 'http://localhost:4700/api/v1/otel/v1/traces';

type OtlpValue = { stringValue: string } | { doubleValue: number } | { intValue: string } | { boolValue: boolean };
type OtlpAttr = { key: string; value: OtlpValue };

function attr(key: string, value: unknown): OtlpAttr | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'string') return { key, value: { stringValue: value.slice(0, 2000) } };
  try { return { key, value: { stringValue: JSON.stringify(value).slice(0, 2000) } }; } catch { return null; }
}

function attrs(pairs: Array<[string, unknown]>): OtlpAttr[] {
  return pairs.map(([k, v]) => attr(k, v)).filter((a): a is OtlpAttr => !!a);
}

function hexId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

export function buildOtlpTrace(claim: ClaimRecord, traceId: string, env: Record<string, string | undefined>) {
  const decidedMs = claim.decided_at ? Date.parse(claim.decided_at) : Number.NaN;
  const createdMs = Date.parse(claim.created_at);
  const endMs = Number.isFinite(decidedMs) ? decidedMs : (Number.isFinite(createdMs) ? createdMs + (claim.latency_ms || 0) : Date.now());
  const startMs = Number.isFinite(createdMs) ? createdMs : endMs - (claim.latency_ms || 0);
  const rootSpanId = hexId(8);

  const rootSpan = {
    traceId,
    spanId: rootSpanId,
    name: 'agent claimsight.claim',
    kind: 1,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: attrs([
      ['gen_ai.operation.name', 'agent'],
      ['gen_ai.agent.name', 'claimsight'],
      ['gen_ai.request.model', claim.model],
      ['claimsight.claim_id', claim.claim_id],
      ['claimsight.order_id', claim.order_id],
      ['claimsight.customer_id', claim.customer_id],
      ['claimsight.sku', claim.sku],
      ['claimsight.video_id', claim.video_id],
      ['claimsight.action', claim.decision?.action],
      ['claimsight.status', claim.status],
      ['claimsight.amount', claim.decision?.amount],
      ['claimsight.policy_clauses', (claim.decision?.policy_clauses ?? []).join(',')],
      ['claimsight.fraud_matches', claim.fraud?.matches?.length ?? 0],
      ['claimsight.fraud_suspicious', claim.fraud?.suspicious ?? false],
      ['claimsight.latency_ms', claim.latency_ms],
      ['claimsight.decided_by', claim.decision?.by],
      ['claimsight.txn_id', claim.decision?.txn_id],
      ['claimsight.evidence', claim.evidence_summary],
      ['conversation.id', claim.conversation_id],
    ]),
    status: { code: 1 },
  };

  const toolSpans = (claim.tool_calls ?? []).map((t: ToolCallTrace) => ({
    traceId,
    spanId: hexId(8),
    parentSpanId: rootSpanId,
    name: `tool ${t.name}`,
    kind: 1,
    startTimeUnixNano: nanos(t.started_at),
    endTimeUnixNano: nanos(t.ended_at ?? t.started_at),
    attributes: attrs([
      ['gen_ai.operation.name', 'execute_tool'],
      ['gen_ai.tool.name', t.name],
      ['gen_ai.tool.call.arguments', t.input],
      ['gen_ai.tool.call.result', t.output_preview],
      ['claimsight.claim_id', claim.claim_id],
      ['error.message', t.error],
    ]),
    status: t.ok ? { code: 1 } : { code: 2, message: t.error ?? 'tool failed' },
  }));

  return {
    resourceSpans: [{
      resource: {
        attributes: attrs([
          ['service.name', env.AGENTX_SERVICE_NAME ?? 'claimsight'],
          ['service.version', '1.0.0'],
          ['deployment.environment', env.AGENTX_ENVIRONMENT ?? (env.SELF_BASE_URL?.includes('localhost') ? 'local' : 'production')],
        ]),
      },
      scopeSpans: [{
        scope: { name: 'claimsight.agent', version: '1.0.0' },
        spans: [rootSpan, ...toolSpans],
      }],
    }],
  };
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const body = await readJsonBody(context);
  const claim = (body.claim && typeof body.claim === 'object' ? body.claim : body) as ClaimRecord;
  if (!claim || typeof claim.claim_id !== 'string') {
    return jsonResponse({ emitted: false, reason: 'invalid_claim', message: "'claim' with claim_id is required" }, 400);
  }

  const endpoint = env.AGENTX_OTLP_URL?.trim() || DEFAULT_AGENTX_OTLP_URL;
  const apiKey = env.AGENTX_API_KEY?.trim() ?? '';
  const enabled = !!(env.AGENTX_OTLP_URL?.trim() || apiKey || env.AGENTX_ENABLED === '1');
  const traceId = claim.trace?.trace_id && /^[0-9a-f]{32}$/i.test(claim.trace.trace_id) ? claim.trace.trace_id : hexId(16);
  const payload = buildOtlpTrace(claim, traceId, env);
  const spanCount = payload.resourceSpans[0].scopeSpans[0].spans.length;

  if (!enabled) {
    logger.log(`[agentx-emit] skipped (AGENTX_OTLP_URL / AGENTX_API_KEY unset) claim=${claim.claim_id} spans=${spanCount}`);
    return jsonResponse({ emitted: false, reason: 'agentx_env_unset', trace_id: traceId, spans: spanCount });
  }

  let emitted = false;
  let reason: string | undefined;
  let httpStatus: number | undefined;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(env.AGENTX_TIMEOUT_MS ?? 3000) || 3000),
    });
    httpStatus = res.status;
    emitted = res.ok;
    if (!res.ok) reason = `collector responded ${res.status}`;
  } catch (e) {
    reason = `unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
  }
  logger.log(`[agentx-emit] claim=${claim.claim_id} spans=${spanCount} emitted=${emitted}${reason ? ` (${reason})` : ''}`);

  // Best effort: stamp the trace onto the stored claim so the UI can link to it.
  try {
    const store = await getClaimsStore(env);
    const stored = await getClaim(store, claim.claim_id);
    if (stored) {
      stored.trace = { trace_id: traceId, emitted, exported_at: nowIso(), endpoint, reason };
      stored.updated_at = nowIso();
      await store.set(`claims:${stored.claim_id}`, stored);
    }
  } catch (e) {
    logger.error('[agentx-emit] failed to stamp trace on claim:', e);
  }

  return jsonResponse({ emitted, trace_id: traceId, endpoint, spans: spanCount, http_status: httpStatus, reason });
}
