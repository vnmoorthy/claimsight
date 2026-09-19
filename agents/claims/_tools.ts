/**
 * ClaimSight tool set — private module (agents/claims/_tools.ts, not routed).
 *
 * Builds the eight MCP tools the claims agent is allowed to use (SPEC §3) plus the per-claim
 * state they share. Tool handlers run in the agent process (SDK MCP server), so they can read
 * the claims store and Memories.ai directly, while every *write* that must be visible to the
 * Refund Desk goes through the cloud functions over HTTP (`SELF_BASE_URL`): /refund,
 * /replacement, /claims-record, /agentx-emit. The API keys never reach the model — the model
 * only sees the JSON these handlers return.
 *
 * Kept model-free so it can be driven by a script (see the harness) as well as by the agent.
 */

import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getOrder, getPolicy, nowIso, round2,
  type ClaimAction, type ClaimRecord, type ClaimsStore, type Env, type FraudMatch,
  type OrderRecord, type Policy, type ToolCallTrace, type VideoIndexEntry,
} from '../_kv';
import { MemoriesError, type CaptionSegment, type MemoriesClient } from '../_memories';
import {
  deriveOrderFacts, evidenceLine, extractDamage, extractProducts, looksWorn, mentionsNoDamage,
  statusForAction,
} from '../_policy';

export const TOOL_NAMES = [
  'lookup_order', 'get_policy', 'inspect_evidence', 'fraud_check',
  'execute_refund', 'create_replacement', 'escalate', 'record_decision',
] as const;

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ClaimsToolDeps {
  env: Env;
  store: ClaimsStore;
  memories: MemoriesClient;
  selfBaseUrl: string;
  claimId: string;
  conversationId: string;
  requestStartedAt: number;
  model: string;
  hints: { orderId?: string; videoId?: string; email?: string; evidenceSummary?: string };
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface DecisionBlock {
  claim_id: string;
  action: ClaimAction;
  amount: number;
  policy_clauses: string[];
  evidence: string;
  fraud_matches: number;
  txn_id: string | null;
  latency_ms: number;
}

export interface EvidenceResult {
  video_id: string;
  ready: boolean;
  description: string;
  timeline: CaptionSegment[];
  products_seen: string[];
  damage_observed: string[];
  damage_confirmed: boolean;
  no_damage_statement: boolean;
  looks_worn: boolean;
  frame_url: string | null;
  evidence_line: string;
  stubbed: boolean;
  error?: string;
  message?: string;
}

export interface FraudResult {
  checked: boolean;
  threshold: number;
  candidates: number;
  matches: FraudMatch[];
  unmapped_hits: Array<{ video_id: string; score: number }>;
  is_suspicious: boolean;
  reason: string;
}

export interface ClaimsToolState {
  claimId: string;
  order: OrderRecord | null;
  policy: Policy | null;
  evidence: EvidenceResult | null;
  fraud: FraudResult | null;
  txn: { txn_id: string; amount: number; method: 'refund' | 'replacement'; status: string } | null;
  escalation: { reason: string; recommended_action: string; amount?: number } | null;
  recorded: { claim: ClaimRecord; block: DecisionBlock; trace_id?: string; agentx_emitted: boolean } | null;
  toolCalls: ToolCallTrace[];
}

type ToolOutcome = { result: unknown; isError?: boolean };

function preview(value: unknown, max = 600): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

export function createClaimsTools(deps: ClaimsToolDeps): { tools: Array<SdkMcpToolDefinition<any>>; state: ClaimsToolState } {
  const { env, store, memories, logger } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const state: ClaimsToolState = {
    claimId: deps.claimId, order: null, policy: null, evidence: null, fraud: null,
    txn: null, escalation: null, recorded: null, toolCalls: [],
  };

  // ── plumbing ─────────────────────────────────────────────────────────────

  function traced<A>(name: string, run: (args: A) => Promise<ToolOutcome>) {
    return async (args: A): Promise<CallToolResult> => {
      const started_at = Date.now();
      logger.log(`[tool] ${name} ${preview(args, 200)}`);
      try {
        const { result, isError } = await run(args);
        state.toolCalls.push({ name, started_at, ended_at: Date.now(), ok: !isError, input: args, output_preview: preview(result) });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!isError };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        state.toolCalls.push({ name, started_at, ended_at: Date.now(), ok: false, input: args, error: message });
        logger.error(`[tool] ${name} failed:`, e);
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
      }
    };
  }

  interface SelfResponse { status: number; ok: boolean; body: Record<string, any> }

  async function callSelf(path: string, method: 'GET' | 'POST', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<SelfResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (env.ADMIN_TOKEN?.trim()) headers['x-admin-token'] = env.ADMIN_TOKEN.trim();
    const res = await doFetch(`${deps.selfBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(env.SELF_TIMEOUT_MS ?? 15_000) || 15_000),
    });
    const text = await res.text();
    let data: Record<string, any> = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, ok: res.ok, body: data };
  }

  async function policy(): Promise<Policy> {
    if (!state.policy) state.policy = await getPolicy(store);
    return state.policy;
  }

  function pickSku(order: OrderRecord, evidence: EvidenceResult | null): string {
    if (evidence?.products_seen.length) {
      const hit = order.items.find(i => evidence.products_seen.some(p => p.toLowerCase().includes(i.name.toLowerCase()) || i.name.toLowerCase().includes(p.split(' ').pop() ?? '')));
      if (hit) return hit.sku;
    }
    return order.items[0]?.sku ?? '';
  }

  function buildClaimRecord(input: {
    action: ClaimAction;
    amount: number;
    reason: string;
    policy_clauses: string[];
    recommended_action?: string;
    txn_id?: string;
    evidence_summary?: string;
    sku?: string;
  }): ClaimRecord {
    const order = state.order!;
    const ev = state.evidence;
    const latency = Date.now() - deps.requestStartedAt;
    return {
      claim_id: deps.claimId,
      order_id: order.order_id,
      customer_id: order.customer_id,
      sku: input.sku || pickSku(order, ev),
      video_id: ev?.video_id ?? deps.hints.videoId ?? '',
      evidence_summary: input.evidence_summary || ev?.evidence_line || deps.hints.evidenceSummary?.slice(0, 300) || '',
      damage_assessment: ev
        ? (ev.ready
          ? (ev.damage_confirmed ? `Damage visible: ${ev.damage_observed.join(', ')}` : 'No damage visible in evidence')
          : `Evidence not available (${ev.error ?? 'unknown'})`)
        : (deps.hints.evidenceSummary ? 'Intake evidence summary only (no video inspected)' : 'No evidence inspected'),
      fraud: state.fraud
        ? { checked: state.fraud.checked, suspicious: state.fraud.is_suspicious, matches: state.fraud.matches, note: state.fraud.reason }
        : { checked: false, matches: [] },
      decision: {
        action: input.action,
        amount: round2(input.amount),
        reason: input.reason,
        policy_clauses: input.policy_clauses,
        by: 'agent',
        txn_id: input.txn_id,
        recommended_action: input.recommended_action,
      },
      status: statusForAction(input.action),
      created_at: new Date(deps.requestStartedAt).toISOString(),
      decided_at: input.action === 'escalated' ? undefined : nowIso(),
      latency_ms: latency,
      conversation_id: deps.conversationId,
      tool_calls: state.toolCalls.slice(),
      model: deps.model,
    };
  }

  async function resolveVideoIndex(videoId: string): Promise<VideoIndexEntry | null> {
    const local = await store.get<VideoIndexEntry>(`video_index:${videoId}`);
    if (local) return local;
    try {
      const res = await callSelf(`/claims?video_id=${encodeURIComponent(videoId)}&limit=1`, 'GET');
      const c = Array.isArray(res.body?.claims) ? res.body.claims[0] : undefined;
      if (c && c.claim_id) return { claim_id: c.claim_id, order_id: c.order_id, customer_id: c.customer_id };
    } catch (e) {
      logger.error('[fraud_check] /claims lookup failed:', e);
    }
    return null;
  }

  async function notifySlack(text: string): Promise<{ sent: boolean; error?: string }> {
    const url = env.SLACK_WEBHOOK_URL?.trim();
    if (!url) return { sent: false, error: 'SLACK_WEBHOOK_URL unset' };
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
      });
      return { sent: res.ok, error: res.ok ? undefined : `slack responded ${res.status}` };
    } catch (e) {
      return { sent: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const uiBase = (env.UI_BASE_URL?.trim() || deps.selfBaseUrl).replace(/\/+$/, '');

  // ── tools ────────────────────────────────────────────────────────────────

  const lookupOrder = tool(
    'lookup_order',
    'Look up an order by id (optionally verifying the customer email). Returns the order with policy facts already derived: days since delivery, whether it is inside the return window, per-item line totals, whether each item is replacement-first and in stock, and whether the amount exceeds the auto-approve limit.',
    {
      order_id: z.string().describe('Order id, e.g. A1042'),
      email: z.string().optional().describe('Customer email to verify against the order (optional)'),
    },
    traced<{ order_id: string; email?: string }>('lookup_order', async ({ order_id, email }) => {
      const order = await getOrder(store, order_id);
      if (!order) {
        return { result: { found: false, order_id, message: `Order ${order_id} was not found. Ask the customer to double-check the order number; do not record a decision.` } };
      }
      const pol = await policy();
      state.order = order;
      const facts = deriveOrderFacts(order, pol);
      const { scenario: _scenario, ...publicOrder } = order;
      void _scenario;
      return {
        result: {
          found: true,
          email_matches: email ? email.trim().toLowerCase() === order.email.toLowerCase() : undefined,
          order: { ...publicOrder, items: facts.items },
          days_since_delivery: facts.days_since_delivery,
          within_return_window: facts.within_return_window,
          return_window_days: facts.return_window_days,
          auto_approve_limit: facts.auto_approve_limit,
          order_total_over_limit: facts.order_total_over_limit,
        },
      };
    }),
  );

  const getPolicyTool = tool(
    'get_policy',
    'Return the store refund policy: return window, auto-approve limit, replacement-first categories, non-returnable categories, fraud threshold and the clause texts P1–P6.',
    {},
    traced<Record<string, never>>('get_policy', async () => ({ result: await policy() })),
  );

  const inspectEvidence = tool(
    'inspect_evidence',
    'Watch the customer evidence video through Memories.ai: returns the AI description, a timeline of captions, the products seen, the damage observed (with damage_confirmed), whether apparel looks worn, and a frame_url used by fraud_check.',
    { video_id: z.string().describe('Evidence video id (vid_…)') },
    traced<{ video_id: string }>('inspect_evidence', async ({ video_id }) => {
      try {
        const [summary, caption, moment] = await Promise.all([
          memories.getSummary(video_id),
          memories.getCaption(video_id),
          memories.getMoment(video_id, 0, 10, ['caption', 'frame']),
        ]);
        const text = [summary, caption.text].filter(Boolean).join(' ');
        const products = extractProducts(text, state.order);
        const damage = extractDamage(text);
        const firstDamage = caption.segments.find(s => extractDamage(s.text).length > 0)?.start;
        const ev: EvidenceResult = {
          video_id,
          ready: true,
          description: summary || caption.text,
          timeline: caption.segments,
          products_seen: products,
          damage_observed: damage,
          damage_confirmed: damage.length > 0,
          no_damage_statement: mentionsNoDamage(text),
          looks_worn: looksWorn(text),
          frame_url: moment.frames[0]?.url ?? null,
          evidence_line: evidenceLine(products, damage, firstDamage),
          stubbed: memories.stubbed,
        };
        state.evidence = ev;
        return { result: ev };
      } catch (e) {
        if (e instanceof MemoriesError && (e.status === 409 || e.status === 404)) {
          const ev: EvidenceResult = {
            video_id, ready: false, description: '', timeline: [], products_seen: [], damage_observed: [],
            damage_confirmed: false, no_damage_statement: false, looks_worn: false, frame_url: null,
            evidence_line: 'evidence not available', stubbed: memories.stubbed,
            error: e.code ?? (e.status === 404 ? 'video_not_found' : 'video_not_ready'), message: e.message,
          };
          state.evidence = ev;
          return { result: ev };
        }
        throw e;
      }
    }),
  );

  const fraudCheck = tool(
    'fraud_check',
    'Search the claims collection for other videos whose frames match this evidence (image similarity). Returns matches at or above the similarity threshold mapped to the claim/customer that submitted them, and is_suspicious when a match belongs to a different customer or order.',
    {
      video_id: z.string().describe('Evidence video id that was inspected'),
      order_id: z.string().describe('Order id of the current claim'),
    },
    traced<{ video_id: string; order_id: string }>('fraud_check', async ({ video_id, order_id }) => {
      const order = state.order ?? await getOrder(store, order_id);
      const pol = await policy();
      const threshold = Number(env.FRAUD_SIMILARITY_THRESHOLD ?? pol.fraud?.similarity_threshold ?? 0.8) || 0.8;
      let frameUrl = state.evidence?.video_id === video_id ? state.evidence.frame_url : null;
      if (!frameUrl) {
        try {
          const moment = await memories.getMoment(video_id, 0, 10, ['frame']);
          frameUrl = moment.frames[0]?.url ?? null;
        } catch (e) {
          logger.error('[fraud_check] moment fetch failed:', e);
        }
      }
      const collection = env.MEMORIES_CLAIMS_COLLECTION?.trim() || (memories.stubbed ? 'col_stub_claims' : '');
      const base = { checked: false, threshold, candidates: 0, matches: [] as FraudMatch[], unmapped_hits: [] as Array<{ video_id: string; score: number }>, is_suspicious: false };
      if (!frameUrl) {
        state.fraud = { ...base, reason: 'No frame available for this video; similarity search skipped' };
        return { result: state.fraud };
      }
      if (!collection) {
        state.fraud = { ...base, reason: 'MEMORIES_CLAIMS_COLLECTION is not configured; similarity search skipped' };
        return { result: state.fraud };
      }
      const hits = await memories.searchByImage({ collectionId: collection, imageUrl: frameUrl, topK: 10 });
      const others = hits.filter(h => h.video_id !== video_id);
      const matches: FraudMatch[] = [];
      const unmapped: Array<{ video_id: string; score: number }> = [];
      for (const hit of others) {
        if (hit.score < threshold) continue;
        const entry = await resolveVideoIndex(hit.video_id);
        if (entry) {
          matches.push({ video_id: hit.video_id, claim_id: entry.claim_id, score: Math.round(hit.score * 1000) / 1000, customer_id: entry.customer_id, order_id: entry.order_id });
        } else {
          unmapped.push({ video_id: hit.video_id, score: Math.round(hit.score * 1000) / 1000 });
        }
      }
      const suspicious = matches.filter(m => m.customer_id !== order?.customer_id || (m.order_id && m.order_id !== order_id));
      const result: FraudResult = {
        checked: true,
        threshold,
        candidates: others.length,
        matches,
        unmapped_hits: unmapped,
        is_suspicious: suspicious.length > 0,
        reason: suspicious.length
          ? `Evidence matches ${suspicious.map(m => `${m.video_id} (score ${m.score}, customer ${m.customer_id}, order ${m.order_id ?? '?'})`).join('; ')} submitted by a different account/order (${pol.clauses.P5 ?? 'P5'})`
          : matches.length
            ? 'Only matches from the same customer and order'
            : 'No matching evidence from other accounts',
      };
      state.fraud = result;
      return { result };
    }),
  );

  const executeRefund = tool(
    'execute_refund',
    'Execute a refund through the store ledger (POST /refund). The server enforces policy: the amount must not exceed the order total and refunds above the auto-approve limit are rejected with requires_human_approval — in that case escalate instead. Returns the txn_id on success.',
    {
      order_id: z.string(),
      amount: z.number().describe('Refund amount in USD (the damaged item\'s line total)'),
      reason: z.string().describe('One-line reason citing the policy clauses'),
      claim_id: z.string().optional().describe('Defaults to the current claim id'),
    },
    traced<{ order_id: string; amount: number; reason: string; claim_id?: string }>('execute_refund', async ({ order_id, amount, reason, claim_id }) => {
      const res = await callSelf('/refund', 'POST', { order_id, amount: round2(amount), reason, claim_id: claim_id || deps.claimId });
      if (res.ok && res.body.txn_id) {
        state.txn = { txn_id: res.body.txn_id, amount: Number(res.body.amount), method: 'refund', status: String(res.body.status ?? 'refunded') };
        return { result: { ok: true, ...res.body } };
      }
      const code = res.body?.error;
      const nextStep = code === 'requires_human_approval'
        ? 'Do not retry. Call escalate with recommended_action "refund" and this amount, then record_decision with action "escalated".'
        : 'Do not retry blindly; explain the problem to the customer or escalate.';
      return { result: { ok: false, http_status: res.status, ...res.body, next_step: nextStep } };
    }),
  );

  const createReplacement = tool(
    'create_replacement',
    'Create a replacement shipment through the store ledger (POST /replacement). The server checks the SKU belongs to the order and is in stock, and applies the auto-approve limit. Returns the txn_id on success; on out_of_stock fall back to execute_refund.',
    {
      order_id: z.string(),
      sku: z.string().describe('SKU of the damaged item, e.g. LAMP-03'),
      reason: z.string().describe('One-line reason citing the policy clauses'),
      claim_id: z.string().optional().describe('Defaults to the current claim id'),
    },
    traced<{ order_id: string; sku: string; reason: string; claim_id?: string }>('create_replacement', async ({ order_id, sku, reason, claim_id }) => {
      const res = await callSelf('/replacement', 'POST', { order_id, sku, reason, claim_id: claim_id || deps.claimId });
      if (res.ok && res.body.txn_id) {
        state.txn = { txn_id: res.body.txn_id, amount: Number(res.body.amount), method: 'replacement', status: String(res.body.status ?? 'replacement') };
        return { result: { ok: true, ...res.body } };
      }
      const code = res.body?.error;
      const nextStep = code === 'out_of_stock'
        ? 'The item cannot be replaced; call execute_refund for its line total instead (cite P4 as considered).'
        : code === 'requires_human_approval'
          ? 'Do not retry. Call escalate with recommended_action "replacement", then record_decision with action "escalated".'
          : 'Do not retry blindly; explain the problem to the customer or escalate.';
      return { result: { ok: false, http_status: res.status, ...res.body, next_step: nextStep } };
    }),
  );

  const escalate = tool(
    'escalate',
    'Hand the claim to a human: marks it pending_review on the Refund Desk and posts a Slack summary (when configured). Use for amounts above the limit, suspected fraud, unclear evidence, or any server rejection. Follow with record_decision(action="escalated").',
    {
      claim_id: z.string().optional().describe('Defaults to the current claim id'),
      reason: z.string().describe('Why a human must decide (cite the clauses)'),
      recommended_action: z.enum(['refund', 'replacement', 'deny']).describe('What you recommend the reviewer does'),
      amount: z.number().optional().describe('Amount at stake in USD'),
      policy_clauses: z.array(z.string()).optional().describe('Clauses involved, e.g. ["P3"]'),
      summary: z.string().optional().describe('One paragraph for the reviewer'),
    },
    traced<{ claim_id?: string; reason: string; recommended_action: 'refund' | 'replacement' | 'deny'; amount?: number; policy_clauses?: string[]; summary?: string }>(
      'escalate',
      async ({ reason, recommended_action, amount, policy_clauses, summary }) => {
        if (!state.order) {
          return { result: { ok: false, error: 'order_unknown', message: 'Call lookup_order first so the escalation can be tied to an order.' }, isError: true };
        }
        const ev = state.evidence;
        const item = state.order.items.find(i => i.sku === pickSku(state.order!, ev)) ?? state.order.items[0];
        const amountAtStake = round2(amount ?? (item ? item.unit_price * item.qty : state.order.total));
        state.escalation = { reason, recommended_action, amount: amountAtStake };
        const claim = buildClaimRecord({
          action: 'escalated', amount: amountAtStake, reason, policy_clauses: policy_clauses ?? [], recommended_action,
        });
        const rec = await callSelf('/claims-record', 'POST', { claim });
        const fraudLine = state.fraud?.matches.length
          ? state.fraud.matches.map(m => `${m.video_id} (score ${m.score}, ${m.customer_id}/${m.order_id ?? '?'})`).join(', ')
          : 'none';
        const text = [
          `*ClaimSight escalation* — claim ${deps.claimId} · order ${state.order.order_id} · ${state.order.email}`,
          summary ?? reason,
          `Recommended: ${recommended_action}${amountAtStake ? ` ($${amountAtStake.toFixed(2)})` : ''} · Clauses: ${(policy_clauses ?? []).join(', ') || 'n/a'}`,
          `Evidence: ${ev?.evidence_line ?? 'no video inspected'}${ev?.description ? ` — ${ev.description.slice(0, 220)}` : ''}`,
          `Fraud matches: ${fraudLine}`,
          `Reply in WorkBuddy Refund Desk or open ${uiBase}/desk`,
        ].join('\n');
        const slack = await notifySlack(text);
        return {
          result: {
            status: 'pending_review',
            claim_id: deps.claimId,
            recorded: rec.ok,
            record_error: rec.ok ? undefined : rec.body?.error ?? `http ${res(rec)}`,
            slack_notified: slack.sent,
            slack_error: slack.error,
            desk_url: `${uiBase}/desk`,
            next_step: 'Now call record_decision with action "escalated" and the same amount/clauses.',
          },
        };
      },
    ),
  );

  function res(r: SelfResponse): number { return r.status; }

  const recordDecision = tool(
    'record_decision',
    'Persist the final decision for this claim (claims record, video index, counters, latency) and emit the AgentX trace. Call exactly once, as the last tool call, after executing the refund/replacement or escalating. Returns the `decision` object that must be copied verbatim into the final ```decision block.',
    {
      claim_id: z.string().optional().describe('Defaults to the current claim id'),
      action: z.enum(['refund', 'replacement', 'escalated', 'denied']),
      amount: z.number().optional().describe('Amount refunded / replaced / at stake in USD (0 for denied)'),
      reason: z.string().describe('Plain-language reason'),
      policy_clauses: z.array(z.string()).describe('Clauses applied, e.g. ["P2","P4"]'),
      evidence_summary: z.string().optional().describe('One line, e.g. "white ceramic mug, chip on rim at 0:03"'),
      sku: z.string().optional().describe('SKU of the affected item'),
      txn_id: z.string().optional().describe('Transaction id from execute_refund / create_replacement'),
      recommended_action: z.enum(['refund', 'replacement', 'deny']).optional().describe('For escalations: what the reviewer should do'),
    },
    traced<{ claim_id?: string; action: ClaimAction; amount?: number; reason: string; policy_clauses: string[]; evidence_summary?: string; sku?: string; txn_id?: string; recommended_action?: 'refund' | 'replacement' | 'deny' }>(
      'record_decision',
      async ({ action, amount, reason, policy_clauses, evidence_summary, sku, txn_id, recommended_action }) => {
        if (state.recorded) {
          return { result: { recorded: true, already_recorded: true, decision: state.recorded.block, instruction: 'Copy this decision object verbatim into the final ```decision block.' } };
        }
        if (!state.order) {
          return { result: { ok: false, error: 'order_unknown', message: 'lookup_order must succeed before a decision can be recorded.' }, isError: true };
        }
        const txnId = txn_id || state.txn?.txn_id;
        if ((action === 'refund' || action === 'replacement') && !txnId) {
          return {
            result: {
              ok: false, error: 'no_transaction',
              message: 'A refund/replacement decision needs a txn_id from execute_refund / create_replacement. Execute it first, or record action "escalated" / "denied".',
            },
            isError: true,
          };
        }
        const finalAmount = action === 'denied' ? 0 : round2(amount ?? state.txn?.amount ?? state.escalation?.amount ?? 0);
        const claim = buildClaimRecord({
          action, amount: finalAmount, reason, policy_clauses, recommended_action: recommended_action ?? state.escalation?.recommended_action,
          txn_id: txnId, evidence_summary, sku,
        });
        const rec = await callSelf('/claims-record', 'POST', { claim });
        const stored = (rec.ok && rec.body?.claim) ? rec.body.claim as ClaimRecord : claim;
        const emit = await callSelf('/agentx-emit', 'POST', { claim: stored });
        const block: DecisionBlock = {
          claim_id: deps.claimId,
          action,
          amount: finalAmount,
          policy_clauses,
          evidence: claim.evidence_summary,
          fraud_matches: state.fraud?.matches.length ?? 0,
          txn_id: txnId ?? null,
          latency_ms: claim.latency_ms,
        };
        state.recorded = { claim: stored, block, trace_id: emit.body?.trace_id, agentx_emitted: !!emit.body?.emitted };
        return {
          result: {
            recorded: rec.ok,
            record_error: rec.ok ? undefined : rec.body?.error ?? `http ${rec.status}`,
            claim_id: deps.claimId,
            status: claim.status,
            trace_id: emit.body?.trace_id,
            agentx_emitted: !!emit.body?.emitted,
            decision: block,
            instruction: 'Copy this decision object verbatim into the final ```decision block and end your reply with it.',
          },
        };
      },
    ),
  );

  const tools: Array<SdkMcpToolDefinition<any>> = [
    lookupOrder, getPolicyTool, inspectEvidence, fraudCheck, executeRefund, createReplacement, escalate, recordDecision,
  ];
  return { tools, state };
}
