/**
 * Claims list — EdgeOne Makers Node Function
 * ==========================================
 *
 * File path cloud-functions/claims/index.ts maps to **GET /claims**
 * (POST /claims is the agent route in agents/claims/index.ts).
 *
 * Query: `status=` (auto_approved | pending_review | approved | denied | replacement),
 * `video_id=`, `order_id=`, `customer_id=`, `limit=` (default 100). Newest first.
 * The `video_id` filter is what the agent's fraud check uses to map a similar video back to
 * the account that submitted it.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, listClaims, jsonResponse, errorResponse, getQuery, queryString,
} from '../_kv';

const logger = createLogger('claims');

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const q = getQuery(context);
  const limitRaw = Number(queryString(q, 'limit') ?? 100);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 100;
  const filter = {
    status: queryString(q, 'status'),
    video_id: queryString(q, 'video_id'),
    order_id: queryString(q, 'order_id'),
    customer_id: queryString(q, 'customer_id'),
    limit,
  };
  try {
    const store = await getClaimsStore(env);
    const claims = await listClaims(store, filter);
    logger.log(`[claims] list status=${filter.status ?? '*'} video=${filter.video_id ?? '*'} → ${claims.length}`);
    return jsonResponse({ claims, count: claims.length, filter, backend: store.backend });
  } catch (e) {
    logger.error('[claims] failed:', e);
    return errorResponse(500, 'list_failed', e instanceof Error ? e.message : String(e));
  }
}
