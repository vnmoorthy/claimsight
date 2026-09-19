/**
 * Human decision on an escalated claim — EdgeOne Makers Node Function
 * ===================================================================
 *
 * File path cloud-functions/claims-decision/index.ts maps to **POST /claims-decision**.
 *
 * Body `{ claim_id, decision: "approve" | "deny", note? }` (used by the Refund Desk UI and the
 * WorkBuddy skill). Approving executes the agent's recommended action through the same
 * server-side ledger path as POST /refund / POST /replacement, with human approval set (this
 * is the in-process equivalent of calling /refund with `x-human-approved: true`), then marks
 * the claim approved / replacement. Denying marks it denied. Counters are updated.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  getClaimsStore, resolveEnv, readJsonBody, jsonResponse, errorResponse, pickString,
  getClaim, getOrder, bumpCounters, nowIso, round2, withDisplayFields,
} from '../_kv';
import { applyRefund, applyReplacement, findItem } from '../_ledger';

const logger = createLogger('claims-decision');

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const body = await readJsonBody(context);
  const claimId = pickString(body, 'claim_id', 'claimId');
  const decision = pickString(body, 'decision').toLowerCase();
  const note = pickString(body, 'note');
  const decidedBy = pickString(body, 'decided_by', 'reviewer') || 'human';

  if (!claimId) return errorResponse(400, 'invalid_request', "'claim_id' is required");
  if (decision !== 'approve' && decision !== 'deny') {
    return errorResponse(400, 'invalid_request', "'decision' must be \"approve\" or \"deny\"");
  }

  try {
    const store = await getClaimsStore(env);
    const found = await getClaim(store, claimId);
    if (!found) return errorResponse(404, 'claim_not_found', `Claim ${claimId} not found`, { claim_id: claimId });
    const claim = withDisplayFields(found);
    if (claim.status !== 'pending_review') {
      return errorResponse(409, 'claim_not_pending', `Claim ${claim.display_id} is ${claim.status}, not pending_review`, {
        claim_id: claimId, display_id: claim.display_id, status: claim.status,
      });
    }

    if (decision === 'deny') {
      claim.status = 'denied';
      claim.decision = { ...claim.decision, action: 'denied', by: 'human', note: note || claim.decision.note };
      claim.decided_at = nowIso();
      claim.updated_at = claim.decided_at;
      await store.set(`claims:${claim.claim_id}`, claim);
      const counters = await bumpCounters(store, { denied: 1 });
      logger.log(`[claims-decision] ${claimId} (${claim.display_id}) denied by ${decidedBy}`);
      return jsonResponse({ ok: true, claim_id: claim.claim_id, display_id: claim.display_id, claim, counters });
    }

    // approve → execute the recommended action with human approval
    const recommended = (claim.decision.recommended_action ?? claim.decision.action ?? 'refund').toLowerCase();
    const wantsReplacement = recommended === 'replacement';
    const order = await getOrder(store, claim.order_id);
    if (!order) return errorResponse(404, 'order_not_found', `Order ${claim.order_id} not found`, { order_id: claim.order_id });

    let amount = round2(Number(claim.decision.amount) || 0);
    if (amount <= 0) {
      const item = claim.sku ? findItem(order, claim.sku) : undefined;
      amount = item ? round2(item.unit_price * item.qty) : round2(order.total);
    }

    const outcome = wantsReplacement
      ? await applyReplacement(store, { order_id: claim.order_id, sku: claim.sku, claim_id: claim.claim_id, reason: note || claim.decision.reason, human_approved: true })
      : await applyRefund(store, { order_id: claim.order_id, amount, claim_id: claim.claim_id, reason: note || claim.decision.reason, human_approved: true });

    if (!outcome.ok) {
      logger.log(`[claims-decision] ${claimId} (${claim.display_id}) approve blocked: ${outcome.body.error}`);
      return jsonResponse({ ...outcome.body, claim_id: claimId, display_id: claim.display_id }, outcome.status);
    }

    const fresh = withDisplayFields((await getClaim(store, claimId)) ?? claim); // ledger attached txn_id
    fresh.status = wantsReplacement ? 'replacement' : 'approved';
    fresh.decision = {
      ...fresh.decision,
      action: wantsReplacement ? 'replacement' : 'refund',
      amount: outcome.body.amount,
      by: 'human',
      txn_id: outcome.body.txn_id,
      note: note || fresh.decision.note,
    };
    fresh.decided_at = nowIso();
    fresh.updated_at = fresh.decided_at;
    await store.set(`claims:${fresh.claim_id}`, fresh);
    const counters = await bumpCounters(store, {});
    logger.log(`[claims-decision] ${claimId} (${fresh.display_id}) approved by ${decidedBy} → ${outcome.body.txn_id}`);
    return jsonResponse({ ok: true, claim_id: fresh.claim_id, display_id: fresh.display_id, claim: fresh, txn: outcome.body, counters });
  } catch (e) {
    logger.error('[claims-decision] failed:', e);
    return errorResponse(500, 'decision_failed', e instanceof Error ? e.message : String(e));
  }
}
