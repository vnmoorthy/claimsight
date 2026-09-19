/**
 * Damage Twin callback — EdgeOne Makers Node Function
 * ===================================================
 *
 * File path cloud-functions/twin-ready/index.ts maps to **POST /twin-ready**.
 *
 * The render service (scripts/render-service.ts) calls this when a twin finishes:
 *   `{ claim_id, video_url, poster_url, render_ms }`  → twin.status "ready" (+ ready_at)
 *   `{ claim_id, error, render_ms? }`                 → twin.status "failed"
 *   `{ claim_id, status: "rendering" }`               → twin.status "rendering" (job started; optional)
 * Only the `twin` field of the record changes (no counters, no ledger). Returns the updated record.
 * Protected by `x-admin-token` when ADMIN_TOKEN is set — the same rule as /seed and /claims-record.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, errorResponse, isAdminAuthorized, getClaim,
  withDisplayFields, pickString, pickNumber, nowIso, type TwinInfo,
} from '../_kv';

const logger = createLogger('twin-ready');

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  if (!isAdminAuthorized(context, env)) {
    return errorResponse(401, 'unauthorized', 'x-admin-token header does not match ADMIN_TOKEN');
  }
  const body = await readJsonBody(context);
  const claimId = pickString(body, 'claim_id', 'claimId');
  const videoUrl = pickString(body, 'video_url');
  const posterUrl = pickString(body, 'poster_url');
  const error = pickString(body, 'error');
  const status = pickString(body, 'status').toLowerCase();
  const renderMs = pickNumber(body, 'render_ms');
  if (!claimId) return errorResponse(400, 'invalid_request', "'claim_id' is required");
  const progress = status === 'rendering' || status === 'queued';
  if (!error && !progress && !videoUrl) {
    return errorResponse(400, 'invalid_request', "'video_url' is required unless 'error' (or status \"rendering\") is given");
  }

  try {
    const store = await getClaimsStore(env);
    const found = await getClaim(store, claimId);
    if (!found) return errorResponse(404, 'claim_not_found', `Claim ${claimId} not found`, { claim_id: claimId });
    const claim = withDisplayFields(found);
    const prev: TwinInfo = claim.twin ?? { status: 'unavailable' };
    const ms = renderMs !== undefined && Number.isFinite(renderMs) ? { render_ms: Math.round(renderMs) } : {};
    let twin: TwinInfo;
    if (error) {
      twin = { status: 'failed', requested_at: prev.requested_at, error, ...ms };
    } else if (progress) {
      twin = { status: status as 'rendering' | 'queued', requested_at: prev.requested_at ?? nowIso() };
    } else {
      twin = {
        status: 'ready', requested_at: prev.requested_at, video_url: videoUrl, poster_url: posterUrl || undefined,
        ready_at: nowIso(), ...ms,
      };
    }
    claim.twin = twin;
    claim.updated_at = nowIso();
    await store.set(`claims:${claim.claim_id}`, claim);
    logger.log(`[twin-ready] ${claim.claim_id} (${claim.display_id}) twin=${twin.status}${twin.video_url ? ` ${twin.video_url}` : ''}${twin.error ? ` error=${twin.error}` : ''}${twin.render_ms ? ` ${twin.render_ms}ms` : ''}`);
    return jsonResponse({ ok: true, claim_id: claim.claim_id, display_id: claim.display_id, twin, claim });
  } catch (e) {
    logger.error('[twin-ready] failed:', e);
    return errorResponse(500, 'twin_update_failed', e instanceof Error ? e.message : String(e));
  }
}
