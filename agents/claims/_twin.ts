/**
 * Damage Twin request — private module (agents/claims/_twin.ts, not routed).
 *
 * Turns a recorded claim into the JSON spec that blender/damage_twin.py renders (product proxy,
 * damage marker, evidence frame + decision HUD) and hands it to the render service
 * (scripts/render-service.ts, `TWIN_RENDER_URL`, default http://localhost:8090) with a 2 s budget.
 * The claim never waits for or fails on the render: the answer is `{status:"queued"}` or
 * `{status:"unavailable"}` and the service reports back through POST /twin-ready.
 */

import { nowIso, type ClaimRecord, type Env, type TwinInfo } from '../_kv';

export interface TwinSpec {
  product: string;
  damage_location: string;
  damage_type: string;
  display_id: string;
  order_id: string;
  customer_name?: string;
  evidence_line: string;
  evidence_time?: string;
  action: string;
  amount: number;
  txn_id?: string;
  policy_clauses: string[];
  /** Same-origin poster (/evidence/frames/…) or absolute URL; the render service resolves it. */
  frame_url?: string;
  color?: number[];
}

/** Evidence facts the spec is built from (a subset of inspect_evidence's result). */
export interface TwinEvidence {
  description?: string;
  timeline?: Array<{ start: number; end?: number; text: string }>;
}

interface TwinLogger { log(...args: unknown[]): void }

export const PRODUCT_BY_SKU_PREFIX: Record<string, string> = {
  MUG: 'mug', HDPH: 'headphones', LAMP: 'lamp', VASE: 'vase', TSHIRT: 'tshirt',
};

/** Damage locations blender/_products.py knows per product (first one is the default). */
export const DAMAGE_LOCATIONS: Record<string, string[]> = {
  mug: ['rim', 'handle', 'base'],
  headphones: ['hinge', 'headband', 'cup'],
  lamp: ['shade', 'stem', 'base'],
  vase: ['body', 'neck', 'base'],
  tshirt: ['collar', 'fabric', 'sleeve'],
  generic: ['corner', 'face', 'edge'],
};

const LOCATION_KEYWORDS = ['rim', 'handle', 'base', 'hinge', 'headband', 'cup', 'shade', 'stem', 'body', 'neck', 'collar', 'sleeve', 'fabric'];

const DAMAGE_WORDS: Array<{ re: RegExp; type: string }> = [
  { re: /\bchip(?:ped|s)?\b/, type: 'chip' },
  { re: /\bcrack(?:ed|s)?\b/, type: 'crack' },
  { re: /\bdent(?:ed|s)?\b/, type: 'dent' },
  { re: /\bscuff(?:ed|s)?\b/, type: 'scuff' },
  { re: /\b(?:tear|torn|ripped|rip)\b/, type: 'tear' },
  { re: /\bstain(?:ed|s)?\b/, type: 'stain' },
  { re: /\bscratch(?:ed|es)?\b/, type: 'scratch' },
  { re: /\b(?:bend|bent)\b/, type: 'bend' },
];

const NEGATED = /\b(no|not|without|never|nor|intact)\b/;

/** "MUG-01" → mug, "HDPH-02" → headphones, unknown → generic. */
export function productForSku(sku: string | undefined): string {
  const prefix = String(sku ?? '').trim().toUpperCase().split(/[-_\s]/)[0] ?? '';
  return PRODUCT_BY_SKU_PREFIX[prefix] ?? 'generic';
}

function clauses(text: string): string[] {
  return text.toLowerCase().split(/[.;!?\n]/).map(c => c.trim()).filter(Boolean);
}

/** Earliest damage word in a non-negated clause → chip | crack | dent | scuff | tear | stain | scratch | bend; else "damage". */
export function damageTypeFrom(text: string): string {
  for (const clause of clauses(text)) {
    if (NEGATED.test(clause)) continue;
    let best: { at: number; type: string } | null = null;
    for (const w of DAMAGE_WORDS) {
      const m = w.re.exec(clause);
      if (m && (!best || m.index < best.at)) best = { at: m.index, type: w.type };
    }
    if (best) return best.type;
  }
  return 'damage';
}

/** First location keyword valid for the product — preferring clauses that mention damage — else the product default. */
export function damageLocationFrom(text: string, product: string): string {
  const valid = DAMAGE_LOCATIONS[product] ?? DAMAGE_LOCATIONS.generic;
  const keywords = LOCATION_KEYWORDS.filter(k => valid.includes(k));
  const firstIn = (clause: string): string | null => {
    let best: { at: number; keyword: string } | null = null;
    for (const keyword of keywords) {
      const m = new RegExp(`\\b${keyword}s?\\b`).exec(clause);
      if (m && (!best || m.index < best.at)) best = { at: m.index, keyword };
    }
    return best?.keyword ?? null;
  };
  const parts = clauses(text);
  for (const clause of parts) {
    if (NEGATED.test(clause) || !DAMAGE_WORDS.some(w => w.re.test(clause))) continue;
    const hit = firstIn(clause);
    if (hit) return hit;
  }
  return firstIn(text.toLowerCase()) ?? valid[0];
}

/** First "m:ss" in the texts (caption first), else the moment start seconds formatted the same way. */
export function evidenceTimeFrom(texts: string[], fallbackSeconds?: number): string | undefined {
  for (const t of texts) {
    const m = /\b(\d{1,2}):(\d{2})\b/.exec(t ?? '');
    if (m) return `${Number(m[1])}:${m[2]}`;
  }
  if (typeof fallbackSeconds === 'number' && Number.isFinite(fallbackSeconds) && fallbackSeconds >= 0) {
    return `${Math.floor(fallbackSeconds / 60)}:${String(Math.floor(fallbackSeconds % 60)).padStart(2, '0')}`;
  }
  return undefined;
}

export function buildTwinSpec(input: { claim: ClaimRecord; evidence: TwinEvidence | null; intakeSummary?: string }): TwinSpec {
  const { claim, evidence } = input;
  const product = productForSku(claim.sku);
  const timeline = evidence?.timeline ?? [];
  // Caption / timeline first (that is where Memories.ai puts timestamps), then the one-line summary.
  const texts = [evidence?.description ?? '', ...timeline.map(s => s.text), claim.evidence_summary ?? '', input.intakeSummary ?? '']
    .filter(t => typeof t === 'string' && t.trim());
  const corpus = texts.join('. ');
  const firstDamage = timeline.find(s => {
    const lower = s.text.toLowerCase();
    return !NEGATED.test(lower) && DAMAGE_WORDS.some(w => w.re.test(lower));
  })?.start;
  const spec: TwinSpec = {
    product,
    damage_location: damageLocationFrom(corpus, product),
    damage_type: damageTypeFrom(corpus),
    display_id: claim.display_id,
    order_id: claim.order_id,
    customer_name: claim.customer_name,
    evidence_line: claim.evidence_summary || `${product}, damage reported`,
    evidence_time: evidenceTimeFrom(texts, firstDamage),
    action: claim.decision.action,
    amount: Number(claim.decision.amount) || 0,
    txn_id: claim.decision.txn_id,
    policy_clauses: claim.decision.policy_clauses ?? [],
    frame_url: claim.evidence_frame_url ?? undefined,
  };
  return spec;
}

/** Where the render service lives; null when explicitly disabled (TWIN_RENDER_URL=off / 0 / none / ""). */
export function twinRenderBase(env: Env): string | null {
  const raw = env.TWIN_RENDER_URL;
  const configured = raw === undefined ? 'http://localhost:8090' : raw.trim();
  if (!configured || /^(0|off|false|none|disabled)$/i.test(configured)) return null;
  return configured.replace(/\/+$/, '');
}

/**
 * POST {claim_id, spec} to the render service. Never throws: unreachable / slow (> 2 s) / rejected
 * → `{status:"unavailable", error}`; accepted → `{status:"queued", requested_at}`.
 */
export async function requestTwinRender(opts: {
  env: Env;
  claimId: string;
  spec: TwinSpec;
  fetchImpl?: typeof fetch;
  logger: TwinLogger;
}): Promise<TwinInfo> {
  const base = twinRenderBase(opts.env);
  if (!base) return { status: 'unavailable', error: 'render service disabled (TWIN_RENDER_URL)' };
  const timeoutMs = Number(opts.env.TWIN_REQUEST_TIMEOUT_MS ?? 2000) || 2000;
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const tag = `${opts.spec.product} ${opts.spec.damage_type}@${opts.spec.damage_location}`;
  try {
    const res = await doFetch(`${base}/render/twin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ claim_id: opts.claimId, spec: opts.spec }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = {}; }
    if (!res.ok) {
      const detail = typeof body.error === 'string' ? ` (${body.error})` : '';
      opts.logger.log(`[twin] unavailable claim=${opts.claimId}: render service responded ${res.status}${detail}`);
      return { status: 'unavailable', error: `render service responded ${res.status}${detail}` };
    }
    opts.logger.log(`[twin] queued claim=${opts.claimId} job=${typeof body.job_id === 'string' ? body.job_id : '-'} ${tag} (${Date.now() - started}ms)`);
    return { status: 'queued', requested_at: nowIso() };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const message = err?.name === 'TimeoutError'
      ? `render service did not answer within ${timeoutMs} ms`
      : `render service unreachable${err?.cause?.code ? ` (${err.cause.code})` : ''}: ${err?.message ?? String(e)}`;
    opts.logger.log(`[twin] unavailable claim=${opts.claimId}: ${message}`);
    return { status: 'unavailable', error: message };
  }
}
