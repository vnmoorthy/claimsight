/**
 * Ledger + server-side policy enforcement — private module (starts with `_`, not routed).
 *
 * Shared by POST /refund, POST /replacement and POST /claims-decision so that the rules are
 * enforced in exactly one place, regardless of who asks (agent, human desk, curl):
 *   - the order must exist and the SKU must belong to it
 *   - amount must be > 0 and ≤ order total, and the order's cumulative ledger cannot exceed its total
 *   - amount above policy.auto_approve_limit requires a human (`x-human-approved: true` on the
 *     HTTP endpoints; `human_approved: true` here)
 *   - replacements require the item to be in stock
 *   - one execution per claim (idempotent replay returns the existing txn)
 */

import {
  getOrder, getPolicy, getClaim, bumpCounters, newId, nowIso, round2,
  type ClaimsStore, type LedgerEntry, type OrderRecord, type Json,
} from './_kv';

export interface LedgerSuccess {
  ok: true;
  status: number;
  body: {
    txn_id: string;
    amount: number;
    currency: string;
    status: 'refunded' | 'replacement';
    method: 'refund' | 'replacement';
    order_id: string;
    claim_id?: string;
    sku?: string;
    approved_by: 'agent' | 'human';
    created_at: string;
    idempotent?: boolean;
  };
}

export interface LedgerFailure {
  ok: false;
  status: number;
  body: { error: string; message: string } & Json;
}

export type LedgerOutcome = LedgerSuccess | LedgerFailure;

function fail(status: number, error: string, message: string, extra: Json = {}): LedgerFailure {
  return { ok: false, status, body: { error, message, ...extra } };
}

async function orderLedgerTotal(store: ClaimsStore, orderId: string): Promise<number> {
  const keys = await store.list('ledger:');
  const entries = await Promise.all(keys.map(k => store.get<LedgerEntry>(k)));
  return round2(entries
    .filter((e): e is LedgerEntry => !!e && e.order_id === orderId)
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0));
}

/** Replay guard: a claim that already carries a txn gets the same txn back. */
async function existingTxnForClaim(store: ClaimsStore, claimId: string | undefined): Promise<LedgerEntry | null> {
  if (!claimId) return null;
  const claim = await getClaim(store, claimId);
  const txn = claim?.decision?.txn_id;
  if (!txn) return null;
  return store.get<LedgerEntry>(`ledger:${txn}`);
}

async function commit(
  store: ClaimsStore,
  entry: LedgerEntry,
  counters: Parameters<typeof bumpCounters>[1],
): Promise<void> {
  await store.set(`ledger:${entry.txn_id}`, entry);
  await bumpCounters(store, counters);
  if (entry.claim_id) {
    const claim = await getClaim(store, entry.claim_id);
    if (claim) {
      claim.decision = { ...(claim.decision ?? {}), txn_id: entry.txn_id } as typeof claim.decision;
      if (typeof claim.decision.amount !== 'number') claim.decision.amount = entry.amount;
      claim.updated_at = nowIso();
      await store.set(`claims:${claim.claim_id}`, claim);
    }
  }
}

function success(entry: LedgerEntry, status: 'refunded' | 'replacement', idempotent = false): LedgerSuccess {
  return {
    ok: true,
    status: 200,
    body: {
      txn_id: entry.txn_id,
      amount: entry.amount,
      currency: entry.currency,
      status,
      method: entry.method,
      order_id: entry.order_id,
      claim_id: entry.claim_id,
      sku: entry.sku,
      approved_by: entry.approved_by ?? 'agent',
      created_at: entry.created_at,
      ...(idempotent ? { idempotent: true } : {}),
    },
  };
}

export interface RefundInput {
  order_id: string;
  amount: number;
  reason?: string;
  claim_id?: string;
  human_approved: boolean;
}

export async function applyRefund(store: ClaimsStore, input: RefundInput): Promise<LedgerOutcome> {
  const orderId = (input.order_id ?? '').trim();
  if (!orderId) return fail(400, 'invalid_request', "'order_id' is required");
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) return fail(400, 'invalid_amount', "'amount' must be a positive number");

  const order = await getOrder(store, orderId);
  if (!order) return fail(404, 'order_not_found', `Order ${orderId} not found`, { order_id: orderId });

  const replay = await existingTxnForClaim(store, input.claim_id);
  if (replay) return success(replay, replay.method === 'refund' ? 'refunded' : 'replacement', true);

  const policy = await getPolicy(store);
  if (amount > round2(order.total)) {
    return fail(403, 'amount_exceeds_order_total', `Refund ${amount} exceeds order total ${order.total}`, {
      amount, order_total: order.total,
    });
  }
  const already = await orderLedgerTotal(store, orderId);
  if (round2(already + amount) > round2(order.total)) {
    return fail(403, 'order_refund_exhausted', `Order ${orderId} already has ${already} on the ledger; ${amount} more would exceed its total ${order.total}`, {
      amount, ledger_total: already, order_total: order.total,
    });
  }
  if (amount > policy.auto_approve_limit && !input.human_approved) {
    return fail(403, 'requires_human_approval', `Refund ${amount} exceeds the auto-approve limit ${policy.auto_approve_limit} (${policy.clauses.P3 ?? 'P3'}); escalate for human approval`, {
      amount, limit: policy.auto_approve_limit, policy_clause: 'P3',
    });
  }

  const entry: LedgerEntry = {
    txn_id: newId('txn'),
    order_id: orderId,
    amount,
    currency: order.currency || policy.currency,
    method: 'refund',
    created_at: nowIso(),
    claim_id: input.claim_id,
    reason: input.reason,
    approved_by: input.human_approved ? 'human' : 'agent',
  };
  await commit(store, entry, { refunded_total: amount });
  return success(entry, 'refunded');
}

export interface ReplacementInput {
  order_id: string;
  sku: string;
  claim_id?: string;
  reason?: string;
  human_approved: boolean;
}

export function findItem(order: OrderRecord, sku: string) {
  const wanted = (sku ?? '').trim().toUpperCase();
  return order.items.find(i => i.sku.toUpperCase() === wanted);
}

export async function applyReplacement(store: ClaimsStore, input: ReplacementInput): Promise<LedgerOutcome> {
  const orderId = (input.order_id ?? '').trim();
  if (!orderId) return fail(400, 'invalid_request', "'order_id' is required");
  if (!input.sku || !input.sku.trim()) return fail(400, 'invalid_request', "'sku' is required");

  const order = await getOrder(store, orderId);
  if (!order) return fail(404, 'order_not_found', `Order ${orderId} not found`, { order_id: orderId });

  const item = findItem(order, input.sku);
  if (!item) return fail(400, 'sku_not_in_order', `SKU ${input.sku} is not part of order ${orderId}`, { sku: input.sku });

  const replay = await existingTxnForClaim(store, input.claim_id);
  if (replay) return success(replay, replay.method === 'refund' ? 'refunded' : 'replacement', true);

  if (item.in_stock === false) {
    return fail(409, 'out_of_stock', `SKU ${item.sku} is out of stock; offer a refund instead`, { sku: item.sku });
  }
  const policy = await getPolicy(store);
  const value = round2(item.unit_price * item.qty);
  if (value > policy.auto_approve_limit && !input.human_approved) {
    return fail(403, 'requires_human_approval', `Replacement value ${value} exceeds the auto-approve limit ${policy.auto_approve_limit} (${policy.clauses.P3 ?? 'P3'}); escalate for human approval`, {
      amount: value, limit: policy.auto_approve_limit, policy_clause: 'P3',
    });
  }
  const already = await orderLedgerTotal(store, orderId);
  if (round2(already + value) > round2(order.total)) {
    return fail(403, 'order_refund_exhausted', `Order ${orderId} already has ${already} on the ledger`, {
      amount: value, ledger_total: already, order_total: order.total,
    });
  }

  const entry: LedgerEntry = {
    txn_id: newId('txn'),
    order_id: orderId,
    amount: value,
    currency: order.currency || policy.currency,
    method: 'replacement',
    created_at: nowIso(),
    claim_id: input.claim_id,
    sku: item.sku,
    reason: input.reason,
    approved_by: input.human_approved ? 'human' : 'agent',
  };
  await commit(store, entry, { replacements: 1 });
  return success(entry, 'replacement');
}
