/**
 * Replacement handler — EdgeOne Makers Node Function
 * ==================================================
 *
 * File path cloud-functions/replacement/index.ts maps to **POST /replacement**.
 *
 * Body `{ order_id, sku, claim_id, reason? }`. Same enforcement as /refund (via _ledger.ts):
 * SKU must belong to the order and be in stock; replacement value above the auto-approve
 * limit needs `x-human-approved: true`. Writes `ledger:<txn>` with method "replacement".
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, errorResponse,
  getHeader, isTruthyHeader, pickString,
} from '../_kv';
import { applyReplacement } from '../_ledger';

const logger = createLogger('replacement');

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const body = await readJsonBody(context);
  const humanApproved = isTruthyHeader(getHeader(context, 'x-human-approved'));

  try {
    const store = await getClaimsStore(env);
    const outcome = await applyReplacement(store, {
      order_id: pickString(body, 'order_id', 'orderId'),
      sku: pickString(body, 'sku'),
      claim_id: pickString(body, 'claim_id', 'claimId') || undefined,
      reason: pickString(body, 'reason') || undefined,
      human_approved: humanApproved,
    });
    logger.log(`[replacement] order=${pickString(body, 'order_id')} sku=${pickString(body, 'sku')} human=${humanApproved} → ${outcome.status}`);
    return jsonResponse(outcome.body, outcome.status);
  } catch (e) {
    logger.error('[replacement] failed:', e);
    return errorResponse(500, 'replacement_failed', e instanceof Error ? e.message : String(e));
  }
}
