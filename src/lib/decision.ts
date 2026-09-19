/**
 * Decision block parser.
 *
 * The ClaimSight agent ends its final message with:
 *
 *   ```decision
 *   {"claim_id":"…","action":"refund","amount":24,"policy_clauses":["P2"],…}
 *   ```
 *
 * `extractDecision` pulls that block out of the markdown so the bubble can
 * render a Decision Card instead of raw JSON. It is deliberately tolerant:
 *   - the block is only parsed once the closing fence has arrived;
 *   - while streaming, an *open* fence is hidden (and `pending` is set) so
 *     the reader never watches JSON being typed;
 *   - a block labelled ```json (or unlabelled) is accepted when its payload
 *     is unmistakably a decision.
 */

import type { ClaimAction, Decision } from '../types';

export const KNOWN_ACTIONS: readonly ClaimAction[] = ['refund', 'replacement', 'escalated', 'denied', 'needs_info'];

const ACTION_ALIASES: Record<string, ClaimAction> = {
  refund: 'refund',
  refunded: 'refund',
  auto_refund: 'refund',
  approve: 'refund',
  approved: 'refund',
  auto_approved: 'refund',
  replacement: 'replacement',
  replace: 'replacement',
  replaced: 'replacement',
  escalated: 'escalated',
  escalate: 'escalated',
  escalation: 'escalated',
  pending_review: 'escalated',
  review: 'escalated',
  denied: 'denied',
  deny: 'denied',
  reject: 'denied',
  rejected: 'denied',
  needs_info: 'needs_info',
  need_info: 'needs_info',
  needs_information: 'needs_info',
  needs_more_info: 'needs_info',
  more_info: 'needs_info',
  info_needed: 'needs_info',
  info_requested: 'needs_info',
  unknown_order: 'needs_info',
  order_not_found: 'needs_info',
};

/** Map any action spelling the model (or a human) might use onto the four canonical actions. */
export function canonicalAction(action: string | undefined | null): ClaimAction | null {
  if (!action) return null;
  const key = action.toLowerCase().trim().replace(/[\s-]+/g, '_');
  return ACTION_ALIASES[key] ?? null;
}

/** Closed ```decision … ``` block (the info string may carry extras, e.g. "decision json"). */
const DECISION_BLOCK_RE = /```[ \t]*decision[^\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/i;
/** Any closed fenced block — fallback for ```json-labelled decisions. */
const ANY_BLOCK_RE = /```[^\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
/** An opening ```decision fence with no closing fence yet (mid-stream). */
const OPEN_DECISION_RE = /```[ \t]*decision[^\n]*(?:\r?\n|$)/i;

export interface DecisionExtract {
  decision: Decision | null;
  /** Markdown with the decision block removed (or with the open fence hidden while streaming). */
  text: string;
  /** True while the opening fence has arrived but the closing fence has not. */
  pending: boolean;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^0-9.+-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function normalizeDecision(obj: Record<string, unknown>): Decision {
  const fraudRaw = obj.fraud_matches ?? obj.fraudMatches;
  return {
    claim_id: str(obj.claim_id) ?? str(obj.claimId),
    order_id: str(obj.order_id) ?? str(obj.orderId),
    display_id: str(obj.display_id) ?? str(obj.displayId),
    customer_name: str(obj.customer_name) ?? str(obj.customerName),
    evidence_frame_url: str(obj.evidence_frame_url) ?? str(obj.evidenceFrameUrl),
    mode_label: str(obj.mode_label) ?? str(obj.modeLabel),
    action: String(obj.action).toLowerCase().trim(),
    amount: toNumber(obj.amount),
    currency: typeof obj.currency === 'string' ? obj.currency : undefined,
    policy_clauses: toStringArray(obj.policy_clauses ?? obj.clauses ?? obj.policyClauses),
    evidence: typeof obj.evidence === 'string' ? obj.evidence : undefined,
    fraud_matches: Array.isArray(fraudRaw) ? fraudRaw.length : toNumber(fraudRaw),
    txn_id: typeof obj.txn_id === 'string' ? obj.txn_id : (typeof obj.txnId === 'string' ? obj.txnId : undefined),
    latency_ms: toNumber(obj.latency_ms ?? obj.latencyMs),
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };
}

function parseDecisionJson(raw: string): Decision | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.action === 'string') {
        return normalizeDecision(obj as Record<string, unknown>);
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function stripRange(s: string, start: number, length: number): string {
  const before = s.slice(0, start).replace(/\s+$/, '');
  const after = s.slice(start + length).replace(/^\s+/, '');
  return (before && after ? `${before}\n\n${after}` : before + after).trim();
}

export function extractDecision(content: string, streaming = false): DecisionExtract {
  if (!content || !content.includes('```')) {
    return { decision: null, text: content, pending: false };
  }

  // 1. The canonical ```decision block.
  const m = DECISION_BLOCK_RE.exec(content);
  if (m) {
    const decision = parseDecisionJson(m[1]);
    if (decision) {
      return { decision, text: stripRange(content, m.index, m[0].length), pending: false };
    }
  }

  // 2. Fallback: any closed block whose JSON is unmistakably a decision.
  ANY_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = ANY_BLOCK_RE.exec(content))) {
    if (!/"action"\s*:/.test(block[1])) continue;
    const d = parseDecisionJson(block[1]);
    if (d && canonicalAction(d.action) && (d.claim_id || d.policy_clauses.length > 0 || d.txn_id)) {
      return { decision: d, text: stripRange(content, block.index, block[0].length), pending: false };
    }
  }

  // 3. Mid-stream: hide the half-typed block until the closing fence lands.
  if (streaming) {
    const open = OPEN_DECISION_RE.exec(content);
    if (open) {
      return { decision: null, text: content.slice(0, open.index).replace(/\s+$/, ''), pending: true };
    }
  }

  return { decision: null, text: content, pending: false };
}
