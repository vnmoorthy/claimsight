/**
 * Single claim — EdgeOne Makers Node Function
 * ===========================================
 *
 * File path cloud-functions/claim/index.ts maps to **GET /claim?claim_id=…** (POST `{claim_id}` also works).
 *
 * Returns the full claim record (display fields and `twin` backfilled) or 404 when the id is unknown.
 * The UI polls this while a Damage Twin renders: `twin.status` goes queued → rendering → ready | failed
 * (or `unavailable` when no render service is configured / no evidence was inspected).
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, getClaim, withDisplayFields, jsonResponse, errorResponse, getQuery, queryString,
  readJsonBody, pickString,
} from '../_kv';

const logger = createLogger('claim');

async function respond(context: CloudFunctionContext, claimId: string): Promise<Response> {
  if (!claimId) return errorResponse(400, 'invalid_request', "'claim_id' is required");
  const env = resolveEnv(context.env);
  try {
    const store = await getClaimsStore(env);
    const found = await getClaim(store, claimId);
    if (!found) return errorResponse(404, 'claim_not_found', `Claim ${claimId} not found`, { claim_id: claimId });
    const claim = withDisplayFields(found);
    logger.log(`[claim] ${claim.claim_id} (${claim.display_id}) status=${claim.status} twin=${claim.twin?.status ?? '-'}`);
    return jsonResponse(claim);
  } catch (e) {
    logger.error('[claim] failed:', e);
    return errorResponse(500, 'claim_failed', e instanceof Error ? e.message : String(e));
  }
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const q = getQuery(context);
  return respond(context, (queryString(q, 'claim_id') ?? queryString(q, 'id') ?? '').trim());
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const body = await readJsonBody(context);
  return respond(context, pickString(body, 'claim_id', 'claimId'));
}
