/**
 * ClaimSight runtime helpers — private module (starts with `_`, not routed).
 *
 * 1. Env resolution   — `context.env` first; `process.env` only as the local-dev / test fallback
 *                       (this is the single sanctioned `process.env` read in the backend).
 * 2. Storage adapter  — one tiny get/set/delete/list surface over three backends, chosen once
 *                       per process and logged once:
 *      blob   : Makers Blob via `@edgeone/pages-blob` → getStore({ name, consistency: 'strong' })
 *               keys are modelled as prefixes: orders/<id>.json, claims/<id>.json, counters.json …
 *      kv     : a console-bound KV global (variable name from env CLAIMS_KV) when the runtime
 *               exposes one (Edge runtime style put/get/delete/list)
 *      memory : module-level Map, auto-seeded from data/*.json so `edgeone makers dev` needs
 *               zero console setup (STORAGE=memory forces it; it is also the fallback when the
 *               Blob probe throws, e.g. project not linked)
 * 3. Seed / counters / claim helpers shared by the cloud functions.
 * 4. Request helpers (JSON body, headers, query, responses, ids).
 *
 * This file is duplicated verbatim as agents/_kv.ts: the agents/ and cloud-functions/ bundles
 * are built separately, mirroring how the template duplicates _logger.ts / _redact.ts.
 */

import ordersSeed from '../data/orders.json';
import policySeed from '../data/policy.json';
import videoIndexSeed from '../data/stubs/video_index.json';
import { createLogger } from './_logger';

const logger = createLogger('claimsight');

// ─── Types ─────────────────────────────────────────────────────────────────

export type Env = Record<string, string | undefined>;
export type Json = Record<string, unknown>;

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unit_price: number;
  category: string;
  in_stock?: boolean;
}

export interface OrderRecord {
  order_id: string;
  customer_id: string;
  email: string;
  placed_at: string;
  status: string;
  items: OrderItem[];
  total: number;
  currency: string;
  shipping_address: string;
  delivered_at: string;
  delivered_days_ago?: number;
  scenario?: string;
}

export interface Policy {
  store: string;
  currency: string;
  return_window_days: number;
  auto_approve_limit: number;
  replacement_first_categories: string[];
  non_returnable_categories: string[];
  fraud: { similarity_threshold: number; action: string };
  clauses: Record<string, string>;
}

export interface FraudMatch {
  video_id: string;
  claim_id: string;
  score: number;
  customer_id: string;
  order_id?: string;
}

export type ClaimAction = 'refund' | 'replacement' | 'escalated' | 'denied';
export type ClaimStatus = 'auto_approved' | 'pending_review' | 'approved' | 'denied' | 'replacement';

export interface ClaimDecision {
  action: ClaimAction;
  amount: number;
  reason: string;
  policy_clauses: string[];
  by: 'agent' | 'human';
  txn_id?: string;
  recommended_action?: string;
  note?: string;
}

export interface ToolCallTrace {
  name: string;
  started_at: number;
  ended_at: number;
  ok: boolean;
  input?: unknown;
  output_preview?: string;
  error?: string;
}

export interface ClaimRecord {
  claim_id: string;
  order_id: string;
  customer_id: string;
  sku: string;
  video_id: string;
  evidence_summary: string;
  damage_assessment: string;
  fraud: { checked: boolean; suspicious?: boolean; matches: FraudMatch[]; note?: string };
  decision: ClaimDecision;
  status: ClaimStatus;
  created_at: string;
  decided_at?: string;
  latency_ms: number;
  conversation_id: string;
  tool_calls?: ToolCallTrace[];
  trace?: { trace_id: string; emitted: boolean; exported_at?: string; endpoint?: string; reason?: string };
  model?: string;
  updated_at?: string;
}

export interface LedgerEntry {
  txn_id: string;
  order_id: string;
  amount: number;
  currency: string;
  method: 'refund' | 'replacement';
  created_at: string;
  claim_id?: string;
  sku?: string;
  reason?: string;
  approved_by?: 'agent' | 'human';
}

export interface Counters {
  claims: number;
  auto_approved: number;
  escalated: number;
  denied: number;
  refunded_total: number;
  fraud_flags: number;
  replacements: number;
  updated_at: string;
}

export interface VideoIndexEntry {
  claim_id: string;
  order_id: string;
  customer_id: string;
}

// ─── Env ───────────────────────────────────────────────────────────────────

/**
 * Merge `context.env` over `process.env`. Handlers must pass `context.env`; the process.env
 * fallback exists so the same modules run under the local test harness and `tsx` scripts.
 */
export function resolveEnv(ctxEnv?: Env | null): Env {
  const procEnv: Env = typeof process !== 'undefined' && process.env ? (process.env as Env) : {};
  return { ...procEnv, ...(ctxEnv ?? {}) };
}

/** Memories.ai is stubbed when MEMORIES_STUB=1 or no API key is configured. */
export function isMemoriesStubbed(env: Env): boolean {
  if (env.MEMORIES_STUB === '1' || env.MEMORIES_STUB === 'true') return true;
  return !(env.MEMORIES_API_KEY && env.MEMORIES_API_KEY.trim());
}

// ─── Storage adapter ───────────────────────────────────────────────────────

export type StorageBackend = 'blob' | 'kv' | 'memory';

export interface ClaimsStore {
  readonly backend: StorageBackend;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Logical keys (e.g. `claims:clm_x`) that start with `prefix` (e.g. `claims:`). */
  list(prefix: string): Promise<string[]>;
}

/** `orders:A1042` → `orders/A1042.json`; `policy` → `policy.json`. */
function toBlobKey(key: string): string {
  const i = key.indexOf(':');
  return (i === -1 ? key : `${key.slice(0, i)}/${key.slice(i + 1)}`) + '.json';
}

function fromBlobKey(blobKey: string): string {
  const base = blobKey.endsWith('.json') ? blobKey.slice(0, -5) : blobKey;
  const i = base.indexOf('/');
  return i === -1 ? base : `${base.slice(0, i)}:${base.slice(i + 1)}`;
}

/** KV keys must be alphanumeric/underscore: `orders:A1042` → `orders__A1042`. */
function toKvKey(key: string): string {
  return key.replace(/:/g, '__').replace(/[^A-Za-z0-9_]/g, '_');
}

function fromKvKey(kvKey: string): string {
  return kvKey.replace('__', ':');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// memory backend — module-level so every handler in this process shares it.
const MEMORY = new Map<string, string>();

function createMemoryStore(): ClaimsStore {
  return {
    backend: 'memory',
    async get<T>(key: string) {
      const raw = MEMORY.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key, value) { MEMORY.set(key, JSON.stringify(value)); },
    async delete(key) { MEMORY.delete(key); },
    async list(prefix) {
      return [...MEMORY.keys()].filter(k => k.startsWith(prefix)).sort();
    },
  };
}

interface KvGlobalLike {
  get(key: string, type?: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; complete?: boolean; cursor?: string }>;
}

function tryKvGlobal(env: Env): ClaimsStore | null {
  const name = (env.CLAIMS_KV && env.CLAIMS_KV.trim()) || 'CLAIMS_KV';
  const g = (globalThis as Record<string, unknown>)[name] as KvGlobalLike | undefined;
  if (!g || typeof g.get !== 'function' || typeof g.put !== 'function') return null;
  return {
    backend: 'kv',
    async get<T>(key: string) {
      const raw = await g.get(toKvKey(key), 'text');
      if (raw === null || raw === undefined) return null;
      return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
    },
    async set(key, value) { await g.put(toKvKey(key), JSON.stringify(value)); },
    async delete(key) { await g.delete(toKvKey(key)); },
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const page = await g.list({ prefix: toKvKey(prefix), limit: 256, cursor });
        for (const k of page.keys ?? []) out.push(fromKvKey(k.name));
        cursor = page.complete === false ? page.cursor : undefined;
      } while (cursor && ++guard < 50);
      return out.sort();
    },
  };
}

async function tryBlob(env: Env): Promise<{ store: ClaimsStore | null; reason: string }> {
  const name = (env.CLAIMS_BLOB_STORE && env.CLAIMS_BLOB_STORE.trim()) || 'claimsight';
  try {
    const mod = await import('@edgeone/pages-blob');
    // Inside Makers Functions the SDK authenticates itself; projectId/token are only for
    // external access (local scripts). The published types mark them required, hence the cast.
    const opts: Record<string, unknown> = { name, consistency: 'strong' };
    if (env.PAGES_BLOB_PROJECT_ID && env.PAGES_BLOB_TOKEN) {
      opts.projectId = env.PAGES_BLOB_PROJECT_ID;
      opts.token = env.PAGES_BLOB_TOKEN;
    }
    const blob = mod.getStore(opts as unknown as Parameters<typeof mod.getStore>[0]);
    const probeMs = Number(env.CLAIMS_BLOB_PROBE_MS ?? 4000) || 4000;
    await withTimeout(blob.get('__probe__.json', { type: 'text' }), probeMs, 'blob probe');
    const store: ClaimsStore = {
      backend: 'blob',
      async get<T>(key: string) {
        const v = await blob.get(toBlobKey(key), { type: 'json' });
        return (v ?? null) as T | null;
      },
      async set(key, value) { await blob.setJSON(toBlobKey(key), value); },
      async delete(key) { await blob.delete(toBlobKey(key)); },
      async list(prefix) {
        const { blobs } = await blob.list({ prefix: toBlobKey(prefix).replace(/\.json$/, '') });
        return blobs.map(b => fromBlobKey(b.key)).sort();
      },
    };
    return { store, reason: `store=${name}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { store: null, reason: msg.slice(0, 160) };
  }
}

let storePromise: Promise<ClaimsStore> | null = null;

/** Resolve the storage backend once per process (memoised). */
export function getClaimsStore(env: Env): Promise<ClaimsStore> {
  if (!storePromise) storePromise = selectBackend(env);
  return storePromise;
}

async function selectBackend(env: Env): Promise<ClaimsStore> {
  const mode = (env.STORAGE ?? env.CLAIMS_STORAGE ?? 'auto').trim().toLowerCase();
  if (mode !== 'memory') {
    if (mode === 'auto' || mode === 'kv') {
      const kv = tryKvGlobal(env);
      if (kv) {
        logger.log(`[storage] backend=kv (global binding ${env.CLAIMS_KV || 'CLAIMS_KV'})`);
        return kv;
      }
    }
    if (mode === 'auto' || mode === 'blob') {
      const { store, reason } = await tryBlob(env);
      if (store) {
        logger.log(`[storage] backend=blob (${reason})`);
        return store;
      }
      logger.log(`[storage] blob unavailable (${reason}); falling back to in-memory Map`);
    }
  }
  logger.log(`[storage] backend=memory (mode=${mode}; auto-seeded from data/*.json — not persistent)`);
  const mem = createMemoryStore();
  await seedStore(mem, env, { reset: false });
  return mem;
}

// ─── Seed ──────────────────────────────────────────────────────────────────

export interface SeedResult {
  orders: number;
  policy: string;
  counters: Counters;
  video_index_stubs: number;
  seeded_at: string;
}

interface SeedOrder {
  order_id: string;
  customer_id: string;
  email: string;
  status: string;
  placed_days_ago: number;
  delivered_days_ago: number;
  currency: string;
  items: OrderItem[];
  total: number;
  shipping_address: string;
  scenario?: string;
}

function daysAgoIso(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

export function zeroCounters(): Counters {
  return {
    claims: 0, auto_approved: 0, escalated: 0, denied: 0,
    refunded_total: 0, fraud_flags: 0, replacements: 0, updated_at: nowIso(),
  };
}

/** Idempotent: (re)writes policy + orders; resets counters when `reset` or when absent. */
export async function seedStore(store: ClaimsStore, env: Env, opts: { reset: boolean }): Promise<SeedResult> {
  const now = Date.now();
  const policy = policySeed as Policy;
  await store.set('policy', policy);

  const orders = (ordersSeed as { orders: SeedOrder[] }).orders;
  for (const o of orders) {
    const record: OrderRecord = {
      order_id: o.order_id,
      customer_id: o.customer_id,
      email: o.email,
      placed_at: daysAgoIso(now, o.placed_days_ago),
      status: o.status,
      items: o.items,
      total: o.total,
      currency: o.currency,
      shipping_address: o.shipping_address,
      delivered_at: daysAgoIso(now, o.delivered_days_ago),
      delivered_days_ago: o.delivered_days_ago,
      scenario: o.scenario,
    };
    await store.set(`orders:${o.order_id}`, record);
  }

  let counters = await store.get<Counters>('counters');
  if (opts.reset || !counters) {
    counters = zeroCounters();
    await store.set('counters', counters);
  }

  let stubs = 0;
  if (isMemoriesStubbed(env)) {
    for (const [vid, entry] of Object.entries(videoIndexSeed as Record<string, unknown>)) {
      if (vid.startsWith('_') || !entry || typeof entry !== 'object') continue;
      const key = `video_index:${vid}`;
      if (opts.reset || !(await store.get(key))) await store.set(key, entry as VideoIndexEntry);
      stubs++;
    }
  }

  return { orders: orders.length, policy: policy.store, counters, video_index_stubs: stubs, seeded_at: new Date(now).toISOString() };
}

export async function getPolicy(store: ClaimsStore): Promise<Policy> {
  return (await store.get<Policy>('policy')) ?? (policySeed as Policy);
}

export async function getOrder(store: ClaimsStore, orderId: string): Promise<OrderRecord | null> {
  if (!orderId) return null;
  return store.get<OrderRecord>(`orders:${orderId.trim()}`);
}

// ─── Counters ──────────────────────────────────────────────────────────────

export async function getCounters(store: ClaimsStore): Promise<Counters> {
  return (await store.get<Counters>('counters')) ?? zeroCounters();
}

export async function bumpCounters(
  store: ClaimsStore,
  patch: Partial<Record<Exclude<keyof Counters, 'updated_at'>, number>>,
): Promise<Counters> {
  const counters = await getCounters(store);
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const key = k as Exclude<keyof Counters, 'updated_at'>;
    counters[key] = round2((counters[key] ?? 0) + v);
  }
  counters.updated_at = nowIso();
  await store.set('counters', counters);
  return counters;
}

// ─── Claims ────────────────────────────────────────────────────────────────

export async function getClaim(store: ClaimsStore, claimId: string): Promise<ClaimRecord | null> {
  if (!claimId) return null;
  return store.get<ClaimRecord>(`claims:${claimId.trim()}`);
}

export interface ListClaimsFilter {
  status?: string;
  video_id?: string;
  order_id?: string;
  customer_id?: string;
  limit?: number;
}

/** Newest first. */
export async function listClaims(store: ClaimsStore, filter: ListClaimsFilter = {}): Promise<ClaimRecord[]> {
  const keys = await store.list('claims:');
  const claims = (await Promise.all(keys.map(k => store.get<ClaimRecord>(k)))).filter(
    (c): c is ClaimRecord => !!c && typeof c === 'object' && typeof (c as ClaimRecord).claim_id === 'string',
  );
  const out = claims.filter(c =>
    (!filter.status || c.status === filter.status) &&
    (!filter.video_id || c.video_id === filter.video_id) &&
    (!filter.order_id || c.order_id === filter.order_id) &&
    (!filter.customer_id || c.customer_id === filter.customer_id),
  );
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return typeof filter.limit === 'number' && filter.limit > 0 ? out.slice(0, filter.limit) : out;
}

export function isFraudFlagged(claim: ClaimRecord): boolean {
  return !!claim.fraud && (claim.fraud.suspicious === true || (claim.fraud.matches?.length ?? 0) > 0);
}

/** Write claims:<id> (+ video_index) and bump counters on first insert. */
export async function upsertClaim(store: ClaimsStore, claim: ClaimRecord): Promise<{ claim: ClaimRecord; created: boolean }> {
  const existing = await getClaim(store, claim.claim_id);
  const merged: ClaimRecord = { ...(existing ?? {}), ...claim, updated_at: nowIso() } as ClaimRecord;
  await store.set(`claims:${merged.claim_id}`, merged);
  if (merged.video_id) {
    await store.set(`video_index:${merged.video_id}`, {
      claim_id: merged.claim_id, order_id: merged.order_id, customer_id: merged.customer_id,
    } satisfies VideoIndexEntry);
  }
  if (!existing) {
    const patch: Partial<Record<Exclude<keyof Counters, 'updated_at'>, number>> = { claims: 1 };
    // `replacements` and `refunded_total` are owned by the ledger (_ledger.ts); only tally decisions here.
    if (merged.status === 'auto_approved' || merged.status === 'replacement') patch.auto_approved = 1;
    if (merged.status === 'pending_review') patch.escalated = 1;
    if (merged.status === 'denied') patch.denied = 1;
    if (isFraudFlagged(merged)) patch.fraud_flags = 1;
    await bumpCounters(store, patch);
  }
  return { claim: merged, created: !existing };
}

// ─── Request / response helpers ────────────────────────────────────────────

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...(extraHeaders ?? {}) } });
}

export function errorResponse(status: number, code: string, message: string, extra?: Json): Response {
  return jsonResponse({ error: code, message, ...(extra ?? {}) }, status);
}

function isJsonObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ReadableStream);
}

interface RequestLike {
  body?: unknown;
  json?: () => Promise<unknown>;
  headers?: unknown;
  query?: unknown;
  url?: string;
}

/**
 * Read a JSON object body. The Makers runtime pre-parses `request.body` by Content-Type
 * (possibly behind a Promise); fall back to the Web `json()` reader.
 */
export async function readJsonBody(context: { request?: unknown }): Promise<Json> {
  const req = context.request as RequestLike | undefined;
  if (!req) return {};
  try {
    const pre = await (req.body as unknown);
    if (isJsonObject(pre)) return pre;
    if (typeof pre === 'string' && pre.trim().startsWith('{')) return JSON.parse(pre) as Json;
  } catch { /* fall through */ }
  try {
    if (typeof req.json === 'function') {
      const parsed = await req.json();
      if (isJsonObject(parsed)) return parsed;
    }
  } catch { /* not JSON */ }
  return {};
}

/** Header lookup that works for Web `Headers` (cloud functions) and plain objects (agents). */
export function getHeader(context: { request?: unknown }, name: string): string | undefined {
  const h = (context.request as RequestLike | undefined)?.headers;
  if (!h) return undefined;
  const maybe = h as { get?: (n: string) => string | null };
  if (typeof maybe.get === 'function') return maybe.get(name) ?? undefined;
  const obj = h as Record<string, string | undefined>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function getQuery(context: { request?: unknown }): Record<string, unknown> {
  const req = context.request as RequestLike | undefined;
  if (req && isJsonObject(req.query)) return req.query;
  if (req && typeof req.url === 'string') {
    try {
      return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());
    } catch { /* ignore */ }
  }
  return {};
}

export function queryString(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

export function pickString(obj: Json, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

export function pickNumber(obj: Json, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** `x-admin-token` must match ADMIN_TOKEN when it is configured; open otherwise. */
export function isAdminAuthorized(context: { request?: unknown }, env: Env): boolean {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected) return true;
  return getHeader(context, 'x-admin-token')?.trim() === expected;
}

export function isTruthyHeader(value: string | undefined): boolean {
  return !!value && ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Origin of the current request (used to reach sibling cloud functions when SELF_BASE_URL is unset). */
export function requestOrigin(context: { request?: unknown }): string | undefined {
  const url = (context.request as RequestLike | undefined)?.url;
  if (typeof url !== 'string' || !url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
}

export function selfBaseUrl(env: Env, context?: { request?: unknown }): string {
  const explicit = env.SELF_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return (context && requestOrigin(context)) || 'http://localhost:8088';
}
