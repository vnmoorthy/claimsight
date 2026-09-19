/**
 * Policy derivations for the ClaimSight agent — private module (starts with `_`, not routed).
 *
 * The model applies data/policy.json itself; these helpers just turn raw records into the
 * arithmetic-free facts the tools return (days since delivery, window/limit checks, which
 * items are replacement-first, damage / product / wear cues in the evidence text) so the
 * agent never has to do date math or guess at categories.
 */

import type { ClaimAction, ClaimStatus, OrderItem, OrderRecord, Policy } from './_kv';

export interface ItemFacts extends OrderItem {
  line_total: number;
  replacement_first: boolean;
  replacement_possible: boolean;
  non_returnable_if_worn: boolean;
  over_auto_approve_limit: boolean;
}

export interface OrderFacts {
  days_since_delivery: number;
  within_return_window: boolean;
  return_window_days: number;
  auto_approve_limit: number;
  order_total_over_limit: boolean;
  items: ItemFacts[];
}

export function deriveOrderFacts(order: OrderRecord, policy: Policy, now: number = Date.now()): OrderFacts {
  const deliveredMs = Date.parse(order.delivered_at);
  const days = Number.isFinite(deliveredMs) ? Math.floor((now - deliveredMs) / 86_400_000) : Number.NaN;
  const replacementFirst = new Set(policy.replacement_first_categories.map(c => c.toLowerCase()));
  const items: ItemFacts[] = order.items.map(item => {
    const lineTotal = Math.round(item.unit_price * item.qty * 100) / 100;
    const category = (item.category ?? '').toLowerCase();
    const isReplacementFirst = replacementFirst.has(category);
    return {
      ...item,
      line_total: lineTotal,
      replacement_first: isReplacementFirst,
      replacement_possible: isReplacementFirst && item.in_stock !== false,
      non_returnable_if_worn: category === 'apparel' || policy.non_returnable_categories.includes(`${category}_worn`),
      over_auto_approve_limit: lineTotal > policy.auto_approve_limit,
    };
  });
  return {
    days_since_delivery: days,
    within_return_window: Number.isFinite(days) && days >= 0 && days <= policy.return_window_days,
    return_window_days: policy.return_window_days,
    auto_approve_limit: policy.auto_approve_limit,
    order_total_over_limit: order.total > policy.auto_approve_limit,
    items,
  };
}

export const DAMAGE_TERMS = [
  'chip', 'chipped', 'crack', 'cracked', 'dent', 'dented', 'scratch', 'scratched', 'broken', 'shattered',
  'smashed', 'bent', 'tear', 'torn', 'ripped', 'leak', 'leaking', 'flicker', 'flickers', 'does not turn on',
  'stays off', 'wobble', 'wobbles', 'loose', 'missing', 'stain', 'stained', 'damage', 'damaged', 'crushed',
];

export const NO_DAMAGE_PHRASES = [
  'no chips', 'no cracks', 'no damage', 'no visible damage', 'no marks', 'not visible', 'no close-up of damage',
  'no clear close-up', 'appear intact', 'appears intact', 'are intact', 'is intact',
];

const NEGATION = /\b(no|not|without|never|nor)\b/;

/**
 * Damage cues found in evidence text (unique, in order of appearance). Clauses that negate the
 * cue ("no chips, cracks or marks", "not visible") are ignored so a clean clip yields nothing.
 */
export function extractDamage(text: string): string[] {
  const found: Array<{ term: string; at: number }> = [];
  let offset = 0;
  for (const rawClause of text.split(/[.;!?\n]/)) {
    const clause = rawClause.toLowerCase();
    const negated = NEGATION.test(clause);
    if (!negated) {
      for (const term of DAMAGE_TERMS) {
        const at = clause.indexOf(term);
        if (at !== -1 && !found.some(f => term.startsWith(f.term) || f.term.startsWith(term))) {
          found.push({ term, at: offset + at });
        }
      }
    }
    offset += rawClause.length + 1;
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.term);
}

export function mentionsNoDamage(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_DAMAGE_PHRASES.some(p => lower.includes(p));
}

const PRODUCT_TERMS: Record<string, string[]> = {
  'ceramic mug': ['mug', 'cup'],
  'headphones': ['headphone', 'headset', 'ear cup', 'headband'],
  'desk lamp': ['lamp', 'lampshade', 'shade', 'bulb'],
  't-shirt': ['t-shirt', 'tshirt', 'tee', 'shirt'],
  'glass vase': ['vase'],
};

/** Products recognised in evidence text; prefers the order's own item names when given. */
export function extractProducts(text: string, order?: OrderRecord | null): string[] {
  const lower = text.toLowerCase();
  const seen: string[] = [];
  if (order) {
    for (const item of order.items) {
      const words = item.name.toLowerCase().split(/[^a-z-]+/).filter(w => w.length > 3);
      if (words.some(w => lower.includes(w))) seen.push(item.name);
    }
  }
  for (const [label, terms] of Object.entries(PRODUCT_TERMS)) {
    if (terms.some(t => lower.includes(t)) && !seen.some(s => s.toLowerCase().includes(label.split(' ').pop() ?? label))) {
      seen.push(label);
    }
  }
  return seen;
}

export const WORN_TERMS = ['worn', 'washed', 'pilling', 'stretched', 'tag removed', 'tag has been cut', 'tag cut off', 'used'];

const WORN_RE = new RegExp(`\\b(${WORN_TERMS.map(t => t.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i');

/** True when the evidence text suggests apparel has been worn (policy P6). Whole words only ("unused" does not count). */
export function looksWorn(text: string): boolean {
  return WORN_RE.test(text);
}

export function statusForAction(action: ClaimAction): ClaimStatus {
  switch (action) {
    case 'refund': return 'auto_approved';
    case 'replacement': return 'replacement';
    case 'escalated': return 'pending_review';
    case 'denied': return 'denied';
    case 'needs_info': return 'needs_info';
  }
}

/** Short evidence line for the Decision Card, e.g. "white ceramic mug, chip on rim at 0:03". */
export function evidenceLine(products: string[], damage: string[], firstDamageSecond?: number): string {
  const product = products[0] ?? 'item';
  if (!damage.length) return `${product}, no damage visible`;
  const when = typeof firstDamageSecond === 'number' && Number.isFinite(firstDamageSecond)
    ? ` at ${Math.floor(firstDamageSecond / 60)}:${String(Math.floor(firstDamageSecond % 60)).padStart(2, '0')}`
    : '';
  return `${product}, ${damage.slice(0, 2).join(' and ')}${when}`;
}
