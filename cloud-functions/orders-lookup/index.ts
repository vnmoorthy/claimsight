/**
 * Orders lookup — EdgeOne Makers Node Function
 * ============================================
 *
 * File path cloud-functions/orders-lookup/index.ts maps to **POST /orders-lookup**
 * (also accepts GET /orders-lookup?order_id=…).
 *
 * Body `{ order_id, email? }` → the order record (plus `days_since_delivery`) or 404.
 * When an email is supplied it must match the order's email (a mismatch is reported as 404
 * so the endpoint cannot be used to enumerate customers).
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, getOrder, readJsonBody, jsonResponse, errorResponse,
  getQuery, queryString, pickString,
} from '../_kv';

const logger = createLogger('orders-lookup');

async function lookup(context: CloudFunctionContext, orderId: string, email: string): Promise<Response> {
  if (!orderId) return errorResponse(400, 'invalid_request', "'order_id' is required");
  const env = resolveEnv(context.env);
  try {
    const store = await getClaimsStore(env);
    const order = await getOrder(store, orderId);
    if (!order) return errorResponse(404, 'order_not_found', `Order ${orderId} not found`, { order_id: orderId });
    if (email && email.toLowerCase() !== (order.email ?? '').toLowerCase()) {
      logger.log(`[orders-lookup] email mismatch for ${orderId}`);
      return errorResponse(404, 'order_not_found', `Order ${orderId} not found for that email`, { order_id: orderId, reason: 'email_mismatch' });
    }
    const deliveredMs = Date.parse(order.delivered_at);
    const days = Number.isFinite(deliveredMs) ? Math.floor((Date.now() - deliveredMs) / 86_400_000) : null;
    return jsonResponse({ ...order, days_since_delivery: days });
  } catch (e) {
    logger.error('[orders-lookup] failed:', e);
    return errorResponse(500, 'lookup_failed', e instanceof Error ? e.message : String(e));
  }
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const body = await readJsonBody(context);
  return lookup(context, pickString(body, 'order_id', 'orderId'), pickString(body, 'email'));
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const q = getQuery(context);
  return lookup(context, queryString(q, 'order_id') ?? '', queryString(q, 'email') ?? '');
}
