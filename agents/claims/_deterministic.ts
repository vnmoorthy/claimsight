/**
 * Deterministic claims runner — private module (agents/claims/_deterministic.ts, not routed).
 *
 * AGENT_MODE=deterministic (auto-selected when no model key is configured) runs the SAME tool
 * sequence the LLM follows — lookup_order → get_policy → inspect_evidence → fraud_check →
 * decide → execute_refund / create_replacement / escalate → record_decision — in plain code,
 * through the very same tool handlers (./_tools.ts), so the ledger, claim records, Slack and
 * AgentX side effects are identical. It yields the events the UI already understands
 * (tool_called / text_delta / decision / done) and ends with the same fenced ```decision block.
 * It is also the on-stage fallback when the gateway is flaky.
 */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { orderNotFoundMessage, type ClaimAction, type OrderRecord, type Policy } from '../_kv';
import { evidenceLine, extractDamage, extractProducts, looksWorn } from '../_policy';
import type { ClaimsToolSet, ClaimsToolState, DecisionBlock, Logger, NeedsInfo } from './_tools';

export type DeterministicEvent =
  | { type: 'tool_called'; tool: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'decision'; block: DecisionBlock; status: string; trace_id?: string; agentx_emitted: boolean }
  | { type: 'done'; text: string; block: DecisionBlock | null; recorded: boolean };

export interface DeterministicInput {
  message: string;
  hints: { orderId?: string; videoId?: string; email?: string; evidenceSummary?: string };
  tools: Array<SdkMcpToolDefinition<any>>;
  state: ClaimsToolState;
  /** Parks the claim as needs_info (unknown order / no evidence) — no ledger side effects. */
  finalizeNeedsInfo: ClaimsToolSet['finalizeNeedsInfo'];
  signal?: AbortSignal;
  logger: Logger;
}

interface ItemFacts {
  sku: string; name: string; qty: number; unit_price: number; category: string; in_stock?: boolean;
  line_total: number; replacement_first: boolean; replacement_possible: boolean;
  non_returnable_if_worn: boolean; over_auto_approve_limit: boolean;
}

interface LookupResult {
  found: boolean;
  order?: Omit<OrderRecord, 'items'> & { items: ItemFacts[] };
  days_since_delivery?: number;
  within_return_window?: boolean;
  return_window_days?: number;
  auto_approve_limit?: number;
  email_matches?: boolean;
  /** Present when found=false: the sentence to show the customer. */
  customer_message?: string;
}

interface EvidenceFacts {
  ready: boolean;
  description: string;
  products_seen: string[];
  damage_observed: string[];
  damage_confirmed: boolean;
  looks_worn: boolean;
  evidence_line: string;
  first_damage_second?: number;
  error?: string;
  /** Plain-English explanation when the video could not be reviewed. */
  message?: string;
}

const REFUSES_REPLACEMENT = /\b(refund only|just (a|the|my) refund|money back|no replacement|don'?t want (a |the )?replacement|do not want (a |the )?replacement|not (a |the )?replacement)\b/i;

function money(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

/** Find the order id in free text when the intake form did not provide one (e.g. "order A1042"). */
export function extractOrderId(message: string): string | undefined {
  const m = /\b([A-Z]{1,3}\d{3,6})\b/.exec(message);
  return m ? m[1] : undefined;
}

function clauseText(policy: Policy, id: string): string {
  return policy.clauses?.[id] ?? id;
}

export async function* runDeterministicClaim(input: DeterministicInput): AsyncGenerator<DeterministicEvent, void, unknown> {
  const { tools, state, hints, logger } = input;
  const byName = new Map(tools.map(t => [t.name, t]));
  const call = async <T = Record<string, any>>(name: string, args: Record<string, unknown>): Promise<T> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    const res = await tool.handler(args as never, {});
    const text = res.content?.[0] && 'text' in res.content[0] ? String(res.content[0].text) : '{}';
    try { return JSON.parse(text) as T; } catch { return { raw: text } as T; }
  };
  const aborted = () => !!input.signal?.aborted;
  const say = (delta: string): DeterministicEvent => ({ type: 'text_delta', delta });

  const sentences: string[] = [];
  const emit = function* (s: string): Generator<DeterministicEvent> {
    sentences.push(s);
    yield say(`${s} `);
  };

  /**
   * Park the claim as needs_info: say the one customer sentence, record the claim (when there is an
   * order to attach it to) with NO ledger side effects, and end with a needs_info decision block.
   */
  const park = async function* (text: string, info?: NeedsInfo): AsyncGenerator<DeterministicEvent, void, unknown> {
    yield say(text);
    const fin = await input.finalizeNeedsInfo(info);
    let full = text;
    if (fin) {
      yield { type: 'decision', block: fin.block, status: 'needs_info', trace_id: state.recorded?.trace_id, agentx_emitted: !!state.recorded?.agentx_emitted };
      const fenced = `\n\n\`\`\`decision\n${JSON.stringify(fin.block)}\n\`\`\`\n`;
      yield say(fenced);
      full += fenced;
    }
    logger.log(`[deterministic] claim=${state.claimId} parked=${info?.kind ?? state.needsInfo?.kind ?? '-'} recorded=${!!fin?.recorded}`);
    yield { type: 'done', text: full, block: fin?.block ?? null, recorded: !!fin?.recorded };
  };

  // 1. lookup_order
  const orderId = hints.orderId ?? extractOrderId(input.message);
  if (!orderId) {
    yield* park(
      'I can help with that. Could you tell me your order number (it looks like A1042) so I can find the purchase and review the claim?',
      { kind: 'order_not_found', reason: 'No order number given; waiting for the customer to send it', customer_message: 'Waiting for the order number' },
    );
    return;
  }
  yield { type: 'tool_called', tool: 'lookup_order' };
  const lookup = await call<LookupResult>('lookup_order', hints.email ? { order_id: orderId, email: hints.email } : { order_id: orderId });
  if (!lookup.found || !lookup.order) {
    // lookup_order already parked the claim (state.needsInfo); the customer sees one plain sentence.
    yield* park(lookup.customer_message ?? orderNotFoundMessage(orderId));
    return;
  }
  if (aborted()) return;
  const order = lookup.order;

  // 2. get_policy
  yield { type: 'tool_called', tool: 'get_policy' };
  const policy = await call<Policy>('get_policy', {});
  if (aborted()) return;

  // 3. inspect_evidence (video) — or the intake summary when no clip is attached
  let evidence: EvidenceFacts | null = null;
  if (hints.videoId) {
    yield { type: 'tool_called', tool: 'inspect_evidence' };
    const ev = await call<Record<string, any>>('inspect_evidence', { video_id: hints.videoId });
    evidence = {
      ready: ev.ready !== false,
      description: ev.description ?? '',
      products_seen: ev.products_seen ?? [],
      damage_observed: ev.damage_observed ?? [],
      damage_confirmed: !!ev.damage_confirmed,
      looks_worn: !!ev.looks_worn,
      evidence_line: ev.evidence_line ?? 'evidence not available',
      first_damage_second: Array.isArray(ev.timeline) ? ev.timeline.find((s: { text: string }) => extractDamage(s.text).length > 0)?.start : undefined,
      error: ev.error,
      message: ev.message,
    };
  } else if (hints.evidenceSummary) {
    const text = hints.evidenceSummary;
    const damage = extractDamage(text);
    const products = extractProducts(text, order);
    evidence = {
      ready: true, description: text, products_seen: products, damage_observed: damage,
      damage_confirmed: damage.length > 0, looks_worn: looksWorn(text), evidence_line: evidenceLine(products, damage),
    };
  } else {
    const text = `I found order ${order.order_id}. To review the claim I need to see the problem: please attach a short video (mp4 or mov) showing the item and the damage, and I'll take it from there.`;
    yield* park(text, {
      kind: 'evidence_missing', order_id: order.order_id,
      reason: 'No evidence attached; waiting for the customer to send a short video of the damage',
      customer_message: text,
    });
    return;
  }
  if (aborted()) return;

  // 4. fraud_check (only when there is a video)
  let fraud: { checked: boolean; is_suspicious: boolean; matches: unknown[]; reason: string } = { checked: false, is_suspicious: false, matches: [], reason: 'no video' };
  if (hints.videoId) {
    yield { type: 'tool_called', tool: 'fraud_check' };
    const f = await call<Record<string, any>>('fraud_check', { video_id: hints.videoId, order_id: order.order_id });
    fraud = { checked: !!f.checked, is_suspicious: !!f.is_suspicious, matches: f.matches ?? [], reason: f.reason ?? '' };
  }
  if (aborted()) return;

  // Which item is the claim about? Prefer the product the evidence shows.
  const item: ItemFacts = order.items.find(i => evidence!.products_seen.some(p => {
    const last = (p.split(' ').pop() ?? p).toLowerCase();
    return i.name.toLowerCase().includes(last) || p.toLowerCase().includes(i.name.toLowerCase());
  })) ?? order.items[0];
  const days = lookup.days_since_delivery ?? 0;
  const limit = lookup.auto_approve_limit ?? policy.auto_approve_limit;
  const refusesReplacement = REFUSES_REPLACEMENT.test(input.message);

  // 5. decide (same order as the system prompt)
  let action: ClaimAction;
  let clauses: string[];
  let reason: string;
  let recommended: 'refund' | 'replacement' | 'deny' | undefined;
  let execError: string | undefined; // set when the ledger declined an execution the policy allowed
  let amount = item.line_total;
  if (!lookup.within_return_window) {
    action = 'denied'; clauses = ['P1']; amount = 0;
    reason = `Delivered ${days} days ago, outside the ${policy.return_window_days}-day return window`;
  } else if (item.category.toLowerCase() === 'apparel' && evidence.looks_worn) {
    action = 'denied'; clauses = ['P6']; amount = 0;
    reason = 'Evidence shows the apparel has been worn';
  } else if (!evidence.damage_confirmed) {
    action = 'escalated'; clauses = ['P2']; recommended = 'deny';
    reason = evidence.ready ? 'No damage is visible in the customer evidence' : (evidence.message ?? 'The evidence video could not be reviewed yet');
  } else if (fraud.is_suspicious) {
    action = 'escalated'; clauses = ['P5', 'P2']; recommended = 'deny';
    reason = fraud.reason || 'Evidence matches a video submitted by a different account';
  } else if (item.over_auto_approve_limit) {
    action = 'escalated'; clauses = ['P3', 'P2']; recommended = item.replacement_possible && !refusesReplacement ? 'replacement' : 'refund';
    reason = `Damage confirmed, but ${money(item.line_total)} is above the ${money(limit)} auto-approve limit`;
  } else if (item.replacement_first && item.replacement_possible && !refusesReplacement) {
    action = 'replacement'; clauses = ['P2', 'P4'];
    reason = `Damage confirmed; ${item.category} items are replaced first when in stock`;
  } else {
    action = 'refund'; clauses = item.replacement_first ? ['P2', 'P4'] : ['P2'];
    reason = item.replacement_first
      ? (refusesReplacement ? 'Damage confirmed; customer declined a replacement' : `Damage confirmed; replacement-first item is out of stock`)
      : 'Damage confirmed, within the return window and the auto-approve limit';
  }

  // 6. execute
  let txnId: string | undefined;
  if (action === 'refund') {
    yield { type: 'tool_called', tool: 'execute_refund' };
    const r = await call<Record<string, any>>('execute_refund', { order_id: order.order_id, amount, reason, claim_id: state.claimId });
    if (r.ok && r.txn_id) txnId = r.txn_id;
    else {
      // The tool already phrased the rejection for customers ("Refund needs a teammate: …"); codes stay in r.error.
      action = 'escalated'; recommended = 'refund'; execError = r.error ?? 'rejected';
      clauses = r.error === 'requires_human_approval' ? ['P3', ...clauses] : clauses;
      reason = r.reason ?? 'Refund needs a teammate: the payments service declined it';
    }
  } else if (action === 'replacement') {
    yield { type: 'tool_called', tool: 'create_replacement' };
    const r = await call<Record<string, any>>('create_replacement', { order_id: order.order_id, sku: item.sku, reason, claim_id: state.claimId });
    if (r.ok && r.txn_id) txnId = r.txn_id;
    else if (r.error === 'out_of_stock') {
      yield { type: 'tool_called', tool: 'execute_refund' };
      const rr = await call<Record<string, any>>('execute_refund', { order_id: order.order_id, amount, reason: 'Damage confirmed; the replacement is out of stock, so a refund is issued instead', claim_id: state.claimId });
      if (rr.ok && rr.txn_id) { action = 'refund'; txnId = rr.txn_id; reason = 'Damage confirmed; the replacement is out of stock, so a refund was issued instead'; }
      else { action = 'escalated'; recommended = 'refund'; execError = rr.error ?? 'rejected'; reason = rr.reason ?? 'Refund needs a teammate: the payments service declined it'; }
    } else {
      action = 'escalated'; recommended = 'replacement'; execError = r.error ?? 'rejected';
      clauses = r.error === 'requires_human_approval' ? ['P3', ...clauses] : clauses;
      reason = r.reason ?? 'Replacement needs a teammate: the payments service declined it';
    }
  }
  if (aborted()) return;
  if (action === 'escalated') {
    yield { type: 'tool_called', tool: 'escalate' };
    await call('escalate', {
      reason, recommended_action: recommended ?? 'refund', amount, policy_clauses: clauses,
      summary: `${reason}. Evidence: ${evidence.evidence_line}.`,
    });
  }

  // 7. record_decision
  yield { type: 'tool_called', tool: 'record_decision' };
  const rec = await call<Record<string, any>>('record_decision', {
    action, amount, reason, policy_clauses: clauses, evidence_summary: evidence.evidence_line, sku: item.sku,
    ...(txnId ? { txn_id: txnId } : {}), ...(recommended ? { recommended_action: recommended } : {}),
  });
  const block: DecisionBlock | null = rec.decision ?? state.recorded?.block ?? null;
  if (block) {
    yield { type: 'decision', block, status: rec.status ?? state.recorded?.claim.status ?? 'unknown', trace_id: rec.trace_id, agentx_emitted: !!rec.agentx_emitted };
  }
  logger.log(`[deterministic] claim=${state.claimId} action=${action} clauses=${clauses.join(',')} txn=${txnId ?? '-'} recorded=${rec.recorded}`);

  // 8. explain, plainly, citing the clauses
  const itemLabel = `${item.name.toLowerCase()} (${item.sku})`;
  const seen = evidence.damage_observed.length
    ? `the ${evidence.damage_observed.slice(0, 2).join(' and ')}${typeof evidence.first_damage_second === 'number' ? ` at 0:${String(evidence.first_damage_second).padStart(2, '0')}` : ''}`
    : 'no visible damage';
  yield* emit(hints.videoId
    ? `Thanks for the video — I watched it and could see ${seen} on the ${item.name.toLowerCase()}.`
    : `Thanks for the details on the ${item.name.toLowerCase()} — I reviewed the evidence you provided and noted ${seen}.`);
  yield* emit(`Order ${order.order_id} was delivered ${days} day${days === 1 ? '' : 's'} ago, ${lookup.within_return_window ? 'inside' : 'outside'} our ${policy.return_window_days}-day return window (P1: ${clauseText(policy, 'P1')}).`);

  switch (action) {
    case 'refund':
      yield* emit(`The damage is clearly visible in your evidence (P2: ${clauseText(policy, 'P2')}).`);
      if (item.replacement_first) {
        yield* emit(refusesReplacement
          ? `We normally offer a replacement first for ${item.category} items (P4: ${clauseText(policy, 'P4')}), but since you asked for a refund I've gone straight to that.`
          : `We normally offer a replacement first for ${item.category} items (P4: ${clauseText(policy, 'P4')}), but the ${item.name.toLowerCase()} is currently out of stock, so I've refunded you instead.`);
      }
      yield* emit(`I've issued a refund of ${money(amount)} to your original payment method — transaction ${txnId}. It should appear within 3–5 business days.`);
      break;
    case 'replacement':
      yield* emit(`The damage is clearly visible in your evidence (P2: ${clauseText(policy, 'P2')}), and because ${item.category} items are replaced first when we have stock (P4: ${clauseText(policy, 'P4')}), I've arranged a replacement ${itemLabel} at no charge — reference ${txnId}.`);
      yield* emit(`It will ship to ${order.shipping_address}; there's no need to send the damaged one back.`);
      break;
    case 'denied':
      if (clauses.includes('P1')) {
        yield* emit(`Because the claim is outside that window, I'm not able to approve a refund or replacement for the ${item.name.toLowerCase()}.`);
        yield* emit('If you believe the delivery date is wrong, reply here and a teammate will double-check it.');
      } else {
        yield* emit(`The video shows the ${item.name.toLowerCase()} has been worn, and worn apparel isn't returnable under our policy (P6: ${clauseText(policy, 'P6')}), so I can't approve this return.`);
        yield* emit('If the item arrived with a defect that isn\'t wear, reply with a clip of it and a teammate will take another look.');
      }
      break;
    case 'escalated':
      if (clauses.includes('P5')) {
        yield* emit(`Before anything is issued, our policy requires a teammate to review this claim, because the evidence matches footage already submitted for a different account (P5: ${clauseText(policy, 'P5')}).`);
      } else if (clauses.includes('P3')) {
        yield* emit(`The damage is visible (P2: ${clauseText(policy, 'P2')}), but ${money(item.line_total)} is above what I can approve on my own (P3: ${clauseText(policy, 'P3')}), so I've sent it to a teammate with a recommendation to ${recommended === 'replacement' ? 'ship a replacement' : 'refund you in full'}.`);
      } else if (execError) {
        const why = execError === 'order_refund_exhausted' ? 'a refund has already been issued against this order'
          : execError === 'amount_exceeds_order_total' ? 'the amount is more than the order total'
          : execError === 'out_of_stock' ? 'the replacement is out of stock and the refund could not be issued automatically'
          : `the payments service declined the automatic ${recommended ?? 'refund'}`;
        yield* emit(`The damage is visible (P2: ${clauseText(policy, 'P2')}) and the claim is within policy, but ${why}, so I've handed it to a teammate to complete rather than guess.`);
      } else {
        yield* emit(`I couldn't see the damage in the evidence (P2: ${clauseText(policy, 'P2')}), so I've asked a teammate to take a closer look rather than decide on my own — if you have a clearer clip or another angle, reply with it and it will be added to the claim.`);
      }
      yield* emit(`Your claim reference is ${state.displayId}; you'll hear back as soon as it's reviewed.`);
      break;
  }

  let text = sentences.join(' ');
  if (block) {
    const fenced = `\n\n\`\`\`decision\n${JSON.stringify(block)}\n\`\`\`\n`;
    yield say(fenced);
    text += fenced;
  }
  yield { type: 'done', text, block, recorded: !!rec.recorded };
}
