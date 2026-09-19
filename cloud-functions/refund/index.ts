/**
 * Refund handler — EdgeOne Makers Node Function
 * =============================================
 *
 * File path cloud-functions/refund/index.ts maps to **POST /refund**.
 *
 * Body `{ order_id, amount, reason, claim_id }`. Server-side policy enforcement lives in
 * _ledger.ts (amount ≤ order total, ≤ policy.auto_approve_limit unless the request carries
 * `x-human-approved: true`, one execution per claim). Writes `ledger:<txn>` and updates
 * `counters`; returns `{ txn_id, amount, status: "refunded", ... }`.
 *
 * The agent cannot exceed the limit even if prompted to: the header is set by the human desk
 * (POST /claims-decision), never by the agent's execute_refund tool.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, errorResponse,
  getHeader, isTruthyHeader, pickString, pickNumber,
} from '../_kv';
import { applyRefund } from '../_ledger';

const logger = createLogger('refund');

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const body = await readJsonBody(context);
  const humanApproved = isTruthyHeader(getHeader(context, 'x-human-approved'));

  try {
    const store = await getClaimsStore(env);
    const outcome = await applyRefund(store, {
      order_id: pickString(body, 'order_id', 'orderId'),
      amount: pickNumber(body, 'amount') ?? Number.NaN,
      reason: pickString(body, 'reason') || undefined,
      claim_id: pickString(body, 'claim_id', 'claimId') || undefined,
      human_approved: humanApproved,
    });
    logger.log(`[refund] order=${pickString(body, 'order_id')} amount=${body.amount} human=${humanApproved} → ${outcome.status} ${outcome.ok ? outcome.body.txn_id : outcome.body.error}`);
    return jsonResponse(outcome.body, outcome.status);
  } catch (e) {
    logger.error('[refund] failed:', e);
    return errorResponse(500, 'refund_failed', e instanceof Error ? e.message : String(e));
  }
}
