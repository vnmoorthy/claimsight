/**
 * Backend API (EdgeOne Makers) — ClaimSight
 *
 * Route mapping (file → route):
 *   agents/claims/index.ts                     → POST /claims            ClaimSight agent (SSE stream)
 *   agents/chat/index.ts                       → POST /chat              Template chat agent (kept, unused by this UI)
 *   agents/stop/index.ts                       → POST /stop              Abort the active agent run
 *   cloud-functions/history/index.ts           → POST /history           Get conversation history
 *   cloud-functions/clear-history/index.ts     → POST /clear-history     Clear conversation history
 *   cloud-functions/conversations/index.ts     → POST /conversations     List conversations for a user
 *   cloud-functions/delete-conversation/…      → POST /delete-conversation
 *   cloud-functions/upload-evidence/…          → POST /upload-evidence   multipart {file, order_id} → {video_id, operation}
 *   cloud-functions/evidence-status/…          → POST /evidence-status   {operation, video_id} → {done, progress, summary?, caption?}
 *   cloud-functions/demo-evidence/…            → GET  /demo-evidence     [{label, video_id, order_id}]
 *   cloud-functions/orders-lookup/…            → POST /orders-lookup     {order_id, email?} → order | 404
 *   cloud-functions/claims-list/…              → GET  /claims-list?status= claim records (newest first)
 *                                                (GET /claims also works locally, but on Makers the agent's
 *                                                 POST /claims may capture every method on that path)
 *   cloud-functions/claims-decision/…          → POST /claims-decision   {claim_id, decision, note}
 *   cloud-functions/stats/…                    → GET  /stats             counters + recent claims + backend/stub flags
 *   cloud-functions/claim/…                    → GET  /claim?claim_id=   one full claim record (Damage Twin polling)
 *   public/lab/results.json                    → GET  /lab/results.json  Synthetic Evidence Lab results (`npm run lab`)
 *
 * This file defines all API paths and request wrappers.
 */

import type {
  Message,
  ImageSsePayload,
  ListConversationsParams,
  ListConversationsResponse,
  BackendStatus,
  ClaimRecord,
  Counters,
  DemoEvidence,
  EvidenceStatusResponse,
  EvidenceUploadResponse,
  LabClip,
  LabCurvePoint,
  LabResults,
  OrderRecord,
  StatsSnapshot,
} from './types';
import { median, toMillis } from './lib/format';
import { normalizeTwin } from './lib/twin';

export const API = {
  chat: '/claims',
  chatStop: '/stop',
  history: '/history',
  clearHistory: '/clear-history',
  conversations: '/conversations',
  deleteConversation: '/delete-conversation',
  uploadEvidence: '/upload-evidence',
  evidenceStatus: '/evidence-status',
  demoEvidence: '/demo-evidence',
  ordersLookup: '/orders-lookup',
  claimsList: '/claims-list',
  claim: '/claim',
  claimsDecision: '/claims-decision',
  stats: '/stats',
  labResults: '/lab/results.json',
} as const;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface RawSseEvent {
  eventType: string;
  data: unknown;
  raw: string;        // raw data string
  timestamp: number;
}

export interface SkillInfo {
  name: string;
  label?: string;
  description?: string;
}

export interface SkillLoadedPayload {
  name: string;
  status: 'loaded';
}

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCalled: (toolName: string) => void;
  onImage: (payload: ImageSsePayload) => void;
  onSkillAvailable?: (skills: SkillInfo[]) => void;
  onSkillLoaded?: (payload: SkillLoadedPayload) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  onRawEvent?: (event: RawSseEvent) => void;
}

/** Claim context sent alongside the chat message (SPEC §3 request body). */
export interface ClaimRequestMeta {
  orderId?: string;
  evidenceVideoId?: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * fetch + JSON with the failure modes this app actually hits:
 *  - backend down → network error (rethrown as-is)
 *  - route missing in prod → the SPA's index.html comes back with 200 → "not JSON"
 *  - 4xx/5xx with a JSON {error} body → ApiError with that message
 */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const obj = (data && typeof data === 'object') ? data as Record<string, unknown> : null;
    const errObj = (obj && obj.error && typeof obj.error === 'object') ? obj.error as Record<string, unknown> : null;
    // Backends answer either {error: 'code', message: '…'} or {error: {code, message}} — show the prose.
    const msg =
      (obj && typeof obj.message === 'string' && obj.message) ||
      (errObj && typeof errObj.message === 'string' && errObj.message) ||
      (obj && typeof obj.error === 'string' && obj.error) ||
      `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  if (data === null) {
    throw new ApiError(
      res.status,
      text.trimStart().startsWith('<')
        ? `Route ${url} is not served by the backend (got HTML)`
        : `Empty or invalid JSON from ${url}`,
    );
  }
  return data as T;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Memories.ai returns summaries as strings or as {summary|text|...} objects. */
function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const key of ['summary', 'text', 'description', 'content', 'caption']) {
      const inner = obj[key];
      if (typeof inner === 'string' && inner.trim()) return inner;
    }
    try {
      const json = JSON.stringify(v);
      return json.length > 400 ? `${json.slice(0, 399)}…` : json;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function pickArray(data: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

/** Get conversation history for restoring the chat window after page refresh. */
export async function fetchConversationHistory(conversationId: string, userId?: string): Promise<Message[]> {
  const startTime = performance.now();
  console.log(`[history] start: ${new Date().toISOString()}`);

  try {
    const res = await fetch(API.history, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    });

    if (!res.ok) {
      console.log(`[history] end: ${new Date().toISOString()}, total: ${(performance.now() - startTime).toFixed(2)}ms`);
      return [];
    }

    const data = await res.json().catch(() => null) as { messages?: Message[] } | null;
    const messages = Array.isArray(data?.messages) ? data.messages : [];

    console.log(`[history] end: ${new Date().toISOString()}, total: ${(performance.now() - startTime).toFixed(2)}ms`);
    return messages;
  } catch {
    console.log(`[history] end: ${new Date().toISOString()}, total: ${(performance.now() - startTime).toFixed(2)}ms`);
    return [];
  }
}

/**
 * Stream POST /claims via SSE
 * Backend pushes events: text_delta / tool_called / ping / done / error
 *
 * Returns an AbortController the caller can use to abort (or pair with /stop for graceful abort).
 */
export function sendMessageStream(
  message: string,
  callbacks: StreamCallbacks,
  conversationId?: string,
  messageIds?: { userMsgId: string; botMsgId: string },
  userId?: string,
  claim?: ClaimRequestMeta,
): AbortController {
  const ctrl = new AbortController();

  (async () => {
    try {
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (conversationId) {
        headers['makers-conversation-id'] = conversationId;
      }

      const body: Record<string, unknown> = {
        message,
        userMsgId: messageIds?.userMsgId,
        botMsgId: messageIds?.botMsgId,
        userId,
      };
      if (claim?.orderId) body.order_id = claim.orderId;
      if (claim?.evidenceVideoId) body.evidence_video_id = claim.evidenceVideoId;

      const res = await fetch(API.chat, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        callbacks.onError(new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        callbacks.onError(new Error('ReadableStream not supported'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let doneReceived = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE format: events separated by \n\n
        const parts = buffer.split('\n\n');
        // Last segment may be incomplete — keep in buffer
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          dispatchSseChunk(part, callbacks, () => { doneReceived = true; });
        }
      }

      // Fallback: trigger done only if backend did not send done event
      if (!doneReceived) {
        callbacks.onDone();
      }
    } catch (err) {
      // AbortError does not trigger error callback
      if (err instanceof DOMException && err.name === 'AbortError') return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return ctrl;
}

/** Parse a single SSE event and dispatch to the corresponding callback */
function dispatchSseChunk(part: string, cb: StreamCallbacks, markDone: () => void): void {
  let eventType = '';
  let data = '';

  for (const line of part.split('\n')) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7);
    } else if (line.startsWith('data: ')) {
      data = line.slice(6);
    }
  }

  if (!eventType || !data) return;

  try {
    const parsed = JSON.parse(data);

    // Debug: push all raw events to onRawEvent
    if (cb.onRawEvent) {
      cb.onRawEvent({
        eventType,
        data: parsed,
        raw: data,
        timestamp: Date.now(),
      });
    }

    switch (eventType) {
      case 'text_delta':
        cb.onTextDelta(parsed.delta);
        break;
      case 'tool_called':
        cb.onToolCalled(parsed.tool);
        break;
      case 'image':
        if (parsed.base64) {
          cb.onImage({
            imageId: parsed.imageId || crypto.randomUUID(),
            base64: parsed.base64,
            mimeType: parsed.mimeType || 'image/png',
            size: parsed.size || 0,
          });
        }
        break;
      case 'error':
        cb.onError(new Error(parsed.message || 'agent returned error'));
        break;
      case 'skills_available':
        cb.onSkillAvailable?.(parsed.skills || []);
        break;
      case 'skill_loaded':
        cb.onSkillLoaded?.({ name: parsed.name, status: 'loaded' });
        break;
      case 'done':
        markDone();
        cb.onDone();
        break;
    }
  } catch {
    // Parse failure also pushed to debug
    if (cb.onRawEvent) {
      cb.onRawEvent({
        eventType,
        data: null,
        raw: data,
        timestamp: Date.now(),
      });
    }
  }
}

/**
 * Request the backend to abort the currently running agent
 *
 * Note: the stop request header must NOT carry the same conversation_id as chat,
 * otherwise the runtime will overwrite chat's cancel_event with stop's cancel_event,
 * causing abort_active_run to fail. The target conversation_id is passed only via body.
 */
export async function stopAgent(conversationId?: string): Promise<boolean> {
  try {
    /**
     * EdgeOne agents/ runtime requires Markers-Conversation-Id on every
     * agents/* request (since 2026-06-05 platform upgrade) — without it
     * the runtime returns 400 (`AGENT_CONVERSATION_ID_REQUIRED`) before
     * the handler runs.
     *
     * Earlier comments in this codebase warned that adding the header on
     * /stop would overwrite chat's abort signal slot. The new runtime is
     * expected to no longer have that bug; if you observe stop succeeding
     * but chat not actually aborting, revisit this and use a different
     * cancellation channel.
     */
    const headers: Record<string, string> = { ...JSON_HEADERS };
    if (conversationId) {
      headers['makers-conversation-id'] = conversationId;
    }
    const res = await fetch(API.chatStop, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Clear backend conversation history for the given conversation ID. */
export async function clearConversationHistory(conversationId?: string, userId?: string): Promise<boolean> {
  if (!conversationId) return false;

  try {
    const res = await fetch(API.clearHistory, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List conversations for the given user (eo-uuid).
 * Returns at most `limit` (default 20) conversations ordered by lastMessageAt desc by default.
 * Pass `after` from a previous response's `nextCursor` to paginate.
 */
export async function listConversations(params: ListConversationsParams): Promise<ListConversationsResponse> {
  const startTime = performance.now();
  console.log(`[conversations] start: ${new Date().toISOString()}`);

  const empty: ListConversationsResponse = { conversations: [] };
  if (!params.userId) return empty;

  try {
    const res = await fetch(API.conversations, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        user_id: params.userId,
        limit: params.limit ?? 20,
        order: params.order ?? 'desc',
        after: params.after,
        before: params.before,
      }),
    });

    if (!res.ok) {
      console.warn(`[conversations] HTTP ${res.status}`);
      console.log(`[conversations] end: ${new Date().toISOString()}, total: ${(performance.now() - startTime).toFixed(2)}ms`);
      return empty;
    }

    const data = await res.json().catch(() => null) as ListConversationsResponse | null;
    console.log(`[conversations] end: ${new Date().toISOString()}, total: ${(performance.now() - startTime).toFixed(2)}ms, count=${data?.conversations?.length ?? 0}`);
    if (!data || !Array.isArray(data.conversations)) return empty;
    return {
      conversations: data.conversations,
      nextCursor: data.nextCursor,
      previousCursor: data.previousCursor,
    };
  } catch (e) {
    console.warn('[conversations] request failed:', e);
    return empty;
  }
}

/**
 * Permanently delete a conversation (messages + metadata + index).
 * Irreversible — caller must already have confirmed with the user.
 */
export async function deleteConversation(conversationId: string, userId?: string): Promise<boolean> {
  if (!conversationId) return false;

  try {
    const res = await fetch(API.deleteConversation, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[delete-conversation] request failed:', e);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ClaimSight — evidence
   ═══════════════════════════════════════════════════════════════ */

/**
 * POST /upload-evidence (multipart: file, order_id) → {video_id, operation}.
 * The cloud function proxies to Memories.ai so the API key never reaches the browser.
 */
export async function uploadEvidence(file: File, orderId: string, signal?: AbortSignal): Promise<EvidenceUploadResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('order_id', orderId);

  const data = await requestJson<Record<string, unknown>>(API.uploadEvidence, {
    method: 'POST',
    body: form,
    signal,
  });

  const nested = (data.data && typeof data.data === 'object') ? data.data as Record<string, unknown> : null;
  const videoId = asString(data.video_id) ?? asString(data.videoId) ?? asString(nested?.video_id) ?? asString(nested?.videoNo);
  const operation = asString(data.operation) ?? asString(data.operation_id) ?? asString(nested?.operation) ?? '';
  if (!videoId) throw new ApiError(200, 'upload-evidence returned no video_id');
  return { video_id: videoId, operation };
}

/** POST /evidence-status {operation, video_id} → {done, progress, summary?, caption?}. */
export async function fetchEvidenceStatus(operation: string, videoId: string): Promise<EvidenceStatusResponse> {
  const data = await requestJson<Record<string, unknown>>(API.evidenceStatus, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ operation, video_id: videoId }),
  });

  const statusStr = asString(data.status)?.toLowerCase();
  const stage = asString(data.stage) ?? asString(data.step) ?? asString(data.phase);
  const failed = data.failed === true || stage === 'failed' || statusStr === 'failed' || statusStr === 'error';
  const done =
    data.done === true ||
    statusStr === 'done' || statusStr === 'completed' || statusStr === 'complete' ||
    statusStr === 'ready' || statusStr === 'succeeded' || statusStr === 'success';

  // `progress` is either a number (0–1 / 0–100) or the Memories.ai operation
  // object {preprocess, index, derive, percent} — read `percent`, else count
  // the finished stages so the bar still moves when percent is absent.
  let progress = asNumber(data.progress) ?? asNumber(data.percent);
  if (progress === undefined && data.progress && typeof data.progress === 'object') {
    const p = data.progress as Record<string, unknown>;
    progress = asNumber(p.percent);
    if (progress === undefined) {
      const finished = ['preprocess', 'index', 'derive'].filter(k => asString(p[k])?.toLowerCase() === 'done').length;
      progress = Math.round((finished / 3) * 100);
    }
  }

  let error = asString(data.error);
  if (!error && data.error && typeof data.error === 'object') {
    const e = data.error as Record<string, unknown>;
    error = asString(e.message) ?? asString(e.code) ?? 'Indexing failed';
  }
  if (!error && failed) error = 'Indexing failed';

  return {
    done: done && !failed,
    progress,
    stage: stage ?? (done ? undefined : statusStr),
    summary: asText(data.summary),
    caption: asText(data.caption),
    error,
  };
}

/** GET /demo-evidence → [{label, video_id, order_id}]. Returns [] when the route is absent. */
export async function fetchDemoEvidence(): Promise<DemoEvidence[]> {
  try {
    const data = await requestJson<unknown>(API.demoEvidence, { method: 'GET' });
    const list = pickArray(data, ['items', 'evidence', 'demo_evidence', 'clips', 'data']) ?? [];
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map(x => ({
        video_id: asString(x.video_id) ?? asString(x.videoId) ?? '',
        order_id: asString(x.order_id) ?? asString(x.orderId) ?? '',
        label: asString(x.label) ?? asString(x.title) ?? asString(x.video_id) ?? '',
        note: asString(x.note) ?? asString(x.description),
      }))
      .filter(x => x.video_id && x.label);
  } catch (e) {
    console.info('[demo-evidence] using static fallback:', (e as Error).message);
    return [];
  }
}

/** POST /orders-lookup {order_id} → order, or null on 404 / any failure. */
export async function lookupOrder(orderId: string, email?: string): Promise<OrderRecord | null> {
  if (!orderId.trim()) return null;
  try {
    const data = await requestJson<Record<string, unknown>>(API.ordersLookup, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ order_id: orderId.trim(), ...(email ? { email } : {}) }),
    });
    const order = (data.order && typeof data.order === 'object') ? data.order as Record<string, unknown> : data;
    if (!asString(order.order_id)) return null;
    return order as unknown as OrderRecord;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ClaimSight — Refund Desk
   ═══════════════════════════════════════════════════════════════ */

function sortNewestFirst(claims: ClaimRecord[]): ClaimRecord[] {
  return [...claims].sort((a, b) => (toMillis(b.created_at) ?? 0) - (toMillis(a.created_at) ?? 0));
}

function coerceClaims(list: unknown[]): ClaimRecord[] {
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map(x => {
      const twin = normalizeTwin(x.twin ?? x.damage_twin);
      const record = { ...x, claim_id: asString(x.claim_id) ?? asString(x.id) ?? crypto.randomUUID() } as ClaimRecord;
      if (twin) record.twin = twin;
      else delete (record as { twin?: unknown }).twin;
      return record;
    });
}

/** GET /claims-list?status= → claim records, newest first. */
export async function fetchClaims(status?: string, limit = 200): Promise<ClaimRecord[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  const url = qs ? `${API.claimsList}?${qs}` : API.claimsList;
  const data = await requestJson<unknown>(url, { method: 'GET' });
  const list = pickArray(data, ['claims', 'items', 'data', 'results']);
  if (!list) throw new ApiError(200, 'GET /claims-list returned no claims array');
  return sortNewestFirst(coerceClaims(list));
}

/**
 * Look a single claim up by id. GET /claims-list has no claim_id filter, so
 * this reads the list (shared for ~4 s) and picks the record — cheap enough
 * for the Decision Card's fraud details and the trace panel's evidence summary.
 */
let _claimsCache: { at: number; promise: Promise<ClaimRecord[]> } | null = null;
export async function fetchClaimById(claimId: string, force = false): Promise<ClaimRecord | null> {
  if (!claimId) return null;
  const now = Date.now();
  if (force || !_claimsCache || now - _claimsCache.at > 4000) {
    const promise = fetchClaims(undefined, 300).catch(() => [] as ClaimRecord[]);
    _claimsCache = { at: now, promise };
  }
  const list = await _claimsCache.promise;
  return list.find(c => c.claim_id === claimId) ?? null;
}

/** The record inside a GET /claim response: bare, or wrapped as {claim} / {record} / {data}. */
function pickClaimRecord(data: unknown): ClaimRecord | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const wrapped = ['claim', 'record', 'data', 'item']
    .map(key => obj[key])
    .find((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
  const src = wrapped ?? obj;
  if (!asString(src.claim_id) && !asString(src.id)) return null;
  return coerceClaims([src])[0] ?? null;
}

/**
 * GET /claim?claim_id= → one full record (the Damage Twin poll). The route is
 * new: while a backend (or the Vite proxy) does not serve it yet, the request
 * comes back as the SPA's HTML or fails, and the record is read from
 * GET /claims-list instead — which carries `twin` too, just a little later.
 */
let _claimRouteMissing = false;
export async function fetchClaim(claimId: string): Promise<ClaimRecord | null> {
  if (!claimId) return null;
  if (!_claimRouteMissing) {
    try {
      const data = await requestJson<unknown>(`${API.claim}?claim_id=${encodeURIComponent(claimId)}`, { method: 'GET' });
      const record = pickClaimRecord(data);
      if (record) return record;
    } catch (e) {
      if (e instanceof ApiError && e.message.includes('got HTML')) {
        _claimRouteMissing = true;
        console.info('[claim] GET /claim is not served here — falling back to GET /claims-list');
      }
    }
  }
  return fetchClaimById(claimId, true);
}

/** GET /stats reduced to what the top bar needs: reachability, data-source label, decision mode, queue size. */
export async function fetchStatus(): Promise<BackendStatus> {
  try {
    const data = await requestJson<Record<string, unknown>>(API.stats, { method: 'GET' });
    const derived = (data.derived && typeof data.derived === 'object') ? data.derived as Record<string, unknown> : {};
    const stubRaw = data.memories_stubbed ?? data.memories_stub ?? data.memoriesStubbed;
    const memoriesStubbed = typeof stubRaw === 'boolean' ? stubRaw : (stubRaw === 1 || stubRaw === '1' || stubRaw === 'true' ? true : undefined);
    const config = (data.config && typeof data.config === 'object') ? data.config as Record<string, unknown> : {};
    const fraud = (data.fraud && typeof data.fraud === 'object') ? data.fraud as Record<string, unknown> : {};
    return {
      online: true,
      backend: asString(data.backend) ?? asString(data.storage),
      memoriesStubbed,
      backendLabel: asString(data.backend_label) ?? asString(data.backendLabel),
      modeLabel: asString(data.mode_label) ?? asString(data.modeLabel),
      pendingReview: asNumber(derived.pending_review) ?? asNumber(data.pending_review),
      fraudSimilarityThreshold:
        asNumber(data.fraud_similarity_threshold) ??
        asNumber(derived.fraud_similarity_threshold) ??
        asNumber(config.fraud_similarity_threshold) ??
        asNumber(fraud.similarity_threshold),
      checkedAt: Date.now(),
    };
  } catch {
    return { online: false, checkedAt: Date.now() };
  }
}

/** GET /stats → normalised counters + recent claims (+ median latency when the backend provides one). */
export async function fetchStats(): Promise<StatsSnapshot> {
  const data = await requestJson<Record<string, unknown>>(API.stats, { method: 'GET' });

  const countersSrc = (data.counters && typeof data.counters === 'object')
    ? data.counters as Record<string, unknown>
    : data;
  const counters: Counters = {
    claims: asNumber(countersSrc.claims) ?? asNumber(countersSrc.total_claims) ?? asNumber(countersSrc.total),
    auto_approved: asNumber(countersSrc.auto_approved),
    escalated: asNumber(countersSrc.escalated) ?? asNumber(countersSrc.pending_review),
    denied: asNumber(countersSrc.denied),
    refunded_total: asNumber(countersSrc.refunded_total) ?? asNumber(countersSrc.refunded),
    fraud_flags: asNumber(countersSrc.fraud_flags),
  };

  const recentRaw =
    pickArray(data.recent, []) ??
    pickArray(data.recent_claims, []) ??
    pickArray(data.last_claims, []) ??
    pickArray(data.latest, []) ??
    (Array.isArray(data.claims) ? data.claims : null) ??
    [];
  const recent = sortNewestFirst(coerceClaims(recentRaw));

  const derived = (data.derived && typeof data.derived === 'object') ? data.derived as Record<string, unknown> : {};
  const medianFromBackend =
    asNumber(derived.median_latency_ms) ??
    asNumber(data.median_latency_ms) ??
    asNumber(data.latency_median_ms) ??
    asNumber((data.latency as Record<string, unknown> | undefined)?.median_ms);
  if (counters.claims === undefined) counters.claims = asNumber(derived.claims_total);
  if (counters.fraud_flags === undefined) counters.fraud_flags = asNumber(derived.fraud_flags);
  if (counters.refunded_total === undefined) counters.refunded_total = asNumber(derived.refunded_total);

  return {
    counters,
    recent,
    medianLatencyMs: medianFromBackend ?? median(recent.map(c => c.latency_ms).filter((n): n is number => typeof n === 'number')),
    currency: asString(data.currency),
  };
}

/** POST /claims-decision {claim_id, decision, note} — human approve/deny for a pending claim. */
export async function submitClaimDecision(
  claimId: string,
  decision: 'approve' | 'deny',
  note: string,
): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>(API.claimsDecision, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ claim_id: claimId, decision, note }),
  });
}


/* ═══════════════════════════════════════════════════════════════
   ClaimSight — Synthetic Evidence Lab
   ═══════════════════════════════════════════════════════════════ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Rates arrive as 0–1; tolerate 0–100 from an older runner. */
function asRate(v: unknown): number | undefined {
  const n = asNumber(v);
  if (n === undefined) return undefined;
  return n > 1 ? n / 100 : n;
}

function coerceLabClip(raw: Record<string, unknown>): LabClip | null {
  const clipId = asString(raw.clip_id) ?? asString(raw.id);
  if (!clipId) return null;
  const matches = (pickArray(raw.top_matches, []) ?? pickArray(raw.matches, []) ?? [])
    .filter(isRecord)
    .map(m => ({ clip_id: asString(m.clip_id) ?? asString(m.id) ?? '', score: asRate(m.score) ?? 0 }))
    .filter(m => m.clip_id)
    .sort((a, b) => b.score - a.score);
  const damagedRaw = raw.damaged;
  return {
    clip_id: clipId,
    product: asString(raw.product) ?? 'generic',
    damaged: damagedRaw === true || damagedRaw === 1 || damagedRaw === 'true',
    damage_type: asString(raw.damage_type) ?? null,
    damage_location: asString(raw.damage_location) ?? null,
    group_id: asString(raw.group_id),
    twin_of: asString(raw.twin_of) ?? null,
    mirrored: raw.mirrored === true || (isRecord(raw.variant) && raw.variant.mirrored === true),
    poster: asString(raw.poster) ?? asString(raw.poster_url) ?? `/lab/clips/${encodeURIComponent(clipId)}.png`,
    top_matches: matches,
  };
}

function coerceLabCurvePoint(raw: Record<string, unknown>): LabCurvePoint | null {
  const threshold = asNumber(raw.threshold);
  if (threshold === undefined) return null;
  return {
    threshold,
    recall: asRate(raw.recall) ?? 0,
    fpr: asRate(raw.fpr) ?? asRate(raw.false_positive_rate) ?? 0,
    precision: asRate(raw.precision) ?? 0,
    f1: asRate(raw.f1) ?? 0,
  };
}

export function coerceLabResults(raw: unknown): LabResults | null {
  if (!isRecord(raw)) return null;
  const clips = (pickArray(raw.clips, []) ?? []).filter(isRecord).map(coerceLabClip).filter((c): c is LabClip => c !== null);
  const curve = (pickArray(raw.curve, []) ?? []).filter(isRecord).map(coerceLabCurvePoint).filter((p): p is LabCurvePoint => p !== null)
    .sort((a, b) => a.threshold - b.threshold);
  if (clips.length === 0 && curve.length === 0) return null;
  const s = isRecord(raw.summary) ? raw.summary : {};
  const detector = asString(raw.detector) ?? asString(s.detector) ?? 'local-baseline';
  return {
    generated_at: asString(raw.generated_at),
    detector,
    collection_id: asString(raw.collection_id),
    options: isRecord(raw.options) ? raw.options : undefined,
    clips,
    curve,
    recommended_threshold: asNumber(raw.recommended_threshold) ?? asNumber(s.recommended_threshold),
    summary: {
      clips: asNumber(s.clips) ?? clips.length,
      twin_pairs: asNumber(s.twin_pairs) ?? clips.filter(c => c.twin_of).length,
      recall: asRate(s.recall),
      fpr: asRate(s.fpr),
      precision: asRate(s.precision),
      mirrored_recall: asRate(s.mirrored_recall),
      render_seconds: asNumber(s.render_seconds),
      detector: asString(s.detector) ?? detector,
    },
  };
}

/**
 * GET /lab/results.json — written by `npm run lab`. Null when the file is not
 * there yet (404, or the SPA's HTML on a fallback route) or is not lab output.
 */
export async function fetchLabResults(): Promise<LabResults | null> {
  try {
    const res = await fetch(API.labResults, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trimStart().startsWith('<')) return null;
    return coerceLabResults(JSON.parse(text));
  } catch (e) {
    console.info('[lab] no results yet:', (e as Error).message);
    return null;
  }
}

/** Reset the demo: re-seeds orders and policy and clears claims, ledger and evidence links (POST /seed). */
export async function resetDemo(): Promise<{ ok: boolean; cleared_records?: number }> {
  const res = await fetch('/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`reset failed: HTTP ${res.status}`);
  return res.json();
}
