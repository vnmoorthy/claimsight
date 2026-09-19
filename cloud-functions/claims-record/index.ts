/**
 * Claim record upsert — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/claims-record/index.ts maps to **POST /claims-record**.
 *
 * Body `{ claim }` (a full claim record, see SPEC §1). Writes `claims:<id>` and
 * `video_index:<video_id>`, bumps `counters` on first insert. The agent's `escalate` and
 * `record_decision` tools call this instead of writing storage directly so that the
 * cloud-function layer is the single owner of claim persistence (the agent runtime and the
 * cloud-function runtime are separate processes locally; in production both share Blob).
 * Protected by `x-admin-token` when ADMIN_TOKEN is set (the agent sends it from its env).
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, errorResponse, isAdminAuthorized,
  upsertClaim, getOrder, nowIso, displayIdFor, modeLabelFor, normalizeTwin,
  type ClaimRecord, type ClaimStatus, type AgentMode,
} from '../_kv';

const logger = createLogger('claims-record');

const STATUSES: ClaimStatus[] = ['auto_approved', 'pending_review', 'approved', 'denied', 'replacement', 'needs_info'];

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  if (!isAdminAuthorized(context, env)) {
    return errorResponse(401, 'unauthorized', 'x-admin-token header does not match ADMIN_TOKEN');
  }
  const body = await readJsonBody(context);
  const raw = (body.claim && typeof body.claim === 'object' ? body.claim : body) as Partial<ClaimRecord>;

  // needs_info records may predate any customer lookup (unknown order), so customer_id is optional for them.
  const required = raw.status === 'needs_info' ? ['claim_id', 'order_id', 'status'] : ['claim_id', 'order_id', 'customer_id', 'status'];
  const missing = required.filter(k => !(raw as Record<string, unknown>)[k]);
  if (missing.length) return errorResponse(400, 'invalid_claim', `claim is missing: ${missing.join(', ')}`);
  if (!STATUSES.includes(raw.status as ClaimStatus)) {
    return errorResponse(400, 'invalid_status', `status must be one of ${STATUSES.join(', ')}`);
  }
  if (!raw.decision || typeof raw.decision !== 'object') {
    return errorResponse(400, 'invalid_claim', 'claim.decision is required');
  }

  const mode: AgentMode | undefined = raw.mode === 'llm' || raw.mode === 'deterministic'
    ? raw.mode
    : raw.model ? (raw.model === 'deterministic' ? 'deterministic' : 'llm') : undefined;
  const claim: ClaimRecord = {
    claim_id: String(raw.claim_id),
    display_id: raw.display_id || displayIdFor(String(raw.claim_id), String(raw.order_id)),
    order_id: String(raw.order_id),
    customer_id: raw.customer_id ? String(raw.customer_id) : '',
    customer_name: raw.customer_name,
    sku: raw.sku ?? '',
    video_id: raw.video_id ?? '',
    evidence_summary: raw.evidence_summary ?? '',
    evidence_frame_url: raw.evidence_frame_url ?? null,
    damage_assessment: raw.damage_assessment ?? '',
    fraud: raw.fraud && typeof raw.fraud === 'object'
      ? { checked: !!raw.fraud.checked, suspicious: raw.fraud.suspicious, matches: Array.isArray(raw.fraud.matches) ? raw.fraud.matches : [], note: raw.fraud.note }
      : { checked: false, matches: [] },
    decision: {
      action: raw.decision.action,
      amount: Number(raw.decision.amount) || 0,
      reason: raw.decision.reason ?? '',
      policy_clauses: Array.isArray(raw.decision.policy_clauses) ? raw.decision.policy_clauses.map(String) : [],
      by: raw.decision.by === 'human' ? 'human' : 'agent',
      txn_id: raw.decision.txn_id,
      recommended_action: raw.decision.recommended_action,
      note: raw.decision.note,
    },
    status: raw.status as ClaimStatus,
    created_at: raw.created_at ?? nowIso(),
    decided_at: raw.decided_at,
    latency_ms: Number(raw.latency_ms) || 0,
    conversation_id: raw.conversation_id ?? '',
    tool_calls: Array.isArray(raw.tool_calls) ? raw.tool_calls : undefined,
    trace: raw.trace,
    model: raw.model,
    mode,
    mode_label: raw.mode_label || (mode ? modeLabelFor(mode, raw.model) : undefined),
  };
  // Damage Twin state travels with the record: record_decision sets queued / unavailable, POST /twin-ready
  // flips it to ready / failed later. Left out of the merge when the body carries none (keeps the stored one).
  const twin = normalizeTwin(raw.twin);
  if (twin) claim.twin = twin;

  try {
    const store = await getClaimsStore(env);
    if (!claim.customer_name || (!claim.customer_id && claim.order_id)) {
      const order = await getOrder(store, claim.order_id);
      if (order) {
        claim.customer_name = claim.customer_name || order.customer_name;
        claim.customer_id = claim.customer_id || order.customer_id;
      }
    }
    const { claim: saved, created } = await upsertClaim(store, claim);
    logger.log(`[claims-record] ${created ? 'created' : 'updated'} ${saved.claim_id} (${saved.display_id}) status=${saved.status} action=${saved.decision.action}`);
    return jsonResponse({ ok: true, created, claim: saved, display_id: saved.display_id, backend: store.backend });
  } catch (e) {
    logger.error('[claims-record] failed:', e);
    return errorResponse(500, 'record_failed', e instanceof Error ? e.message : String(e));
  }
}
