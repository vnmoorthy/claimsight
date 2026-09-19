/**
 * Memories.ai Video Datalake client — private module (starts with `_`, not routed).
 *
 * Base URL : MEMORIES_BASE (default https://api.memories.ai/serve/datalake/v1)
 * Auth     : `Authorization: <MEMORIES_API_KEY>` — the raw key, no "Bearer" prefix.
 * Endpoints: POST /videos (multipart `json` + `file`), GET /operations/{op},
 *            GET /videos/{id}/summary, GET /videos/{id}/caption,
 *            GET /moments/{video_id}@{start}-{end}?expand=caption,frame, POST /search.
 *
 * Every call has a stub path (MEMORIES_STUB=1 or no MEMORIES_API_KEY) that returns the canned
 * responses in data/stubs/*.json — shaped exactly like the real API — so the whole flow can be
 * rehearsed without network. Node ≥ 20: uses global fetch / FormData / Blob.
 *
 * This file is duplicated verbatim as agents/_memories.ts (separate bundles).
 */

import summaryStubs from '../data/stubs/summary.json';
import captionStubs from '../data/stubs/caption.json';
import momentStubs from '../data/stubs/moments.json';
import searchStubs from '../data/stubs/search.json';
import operationStubs from '../data/stubs/operations.json';
import uploadStubs from '../data/stubs/upload.json';
import { createLogger } from './_logger';
import { isMemoriesStubbed, type Env } from './_kv';

export { isMemoriesStubbed };

const logger = createLogger('memories');

export const DEFAULT_MEMORIES_BASE = 'https://api.memories.ai/serve/datalake/v1';

// ─── Types (mirroring the Datalake API) ────────────────────────────────────

export interface CaptionSegment { start: number; end: number; text: string }

export interface OperationStatus {
  operation: string;
  kind?: string;
  done: boolean;
  cancelled?: boolean;
  resource?: string;
  progress: { preprocess?: string; index?: string; derive?: string; percent?: number };
  error: { code: string; message: string } | null;
}

export interface MomentView {
  ref: string;
  caption: CaptionSegment[];
  frames: Array<{ t: number; url: string }>;
  clip_url?: string;
}

export interface SearchHit {
  ref: string;
  video_id: string;
  target?: string;
  score: number;
  start?: number;
  end?: number;
  snippet?: string;
  thumbnail_url?: string;
}

export class MemoriesError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = 'MemoriesError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface UploadInput {
  file: Blob;
  filename: string;
  orderId: string;
  collectionId?: string;
  fps?: number;
}

export interface MemoriesClient {
  readonly stubbed: boolean;
  readonly base: string;
  uploadVideo(input: UploadInput): Promise<{ video_id: string; operation: string; status?: string }>;
  getOperation(operation: string): Promise<OperationStatus>;
  getSummary(videoId: string): Promise<string>;
  getCaption(videoId: string): Promise<{ text: string; segments: CaptionSegment[] }>;
  getMoment(videoId: string, start: number, end: number, expand: string[]): Promise<MomentView>;
  searchByImage(input: { collectionId: string; imageUrl: string; topK?: number }): Promise<SearchHit[]>;
}

// ─── Stub helpers ──────────────────────────────────────────────────────────

function pickStub<T>(table: unknown, key: string): T {
  const t = table as Record<string, unknown>;
  const hit = key && !key.startsWith('_') ? t[key] : undefined;
  const chosen = hit && typeof hit === 'object' ? hit : t.default;
  return chosen as T;
}

/** Search stubs are keyed by the video id embedded in the query frame URL. */
function videoIdFromFrameUrl(url: string): string {
  const m = /\/frames\/([^/]+)\//.exec(url);
  return m ? m[1] : '';
}

function stubOperation(operation: string, env: Env): OperationStatus {
  const m = /^op_stub_(\d+)(?:__(.+))?$/.exec(operation);
  if (!m) {
    const canned = pickStub<OperationStatus>(operationStubs, operation);
    return { ...canned, operation };
  }
  const createdAt = Number(m[1]);
  const resource = m[2];
  const totalSec = Math.max(0, Number(env.MEMORIES_STUB_INDEX_SECONDS ?? 6) || 6);
  const elapsed = (Date.now() - createdAt) / 1000;
  const stage = (from: number, to: number): string =>
    elapsed >= to ? 'done' : elapsed >= from ? 'running' : 'pending';
  const third = totalSec / 3;
  const done = totalSec === 0 || elapsed >= totalSec;
  return {
    operation,
    kind: 'ingest',
    done,
    cancelled: false,
    resource,
    progress: {
      preprocess: stage(0, third),
      index: stage(third, 2 * third),
      derive: stage(2 * third, totalSec),
      percent: done ? 100 : Math.min(99, Math.floor((elapsed / totalSec) * 100)),
    },
    error: null,
  };
}

// ─── Client ────────────────────────────────────────────────────────────────

export function createMemoriesClient(env: Env): MemoriesClient {
  const stubbed = isMemoriesStubbed(env);
  const base = (env.MEMORIES_BASE?.trim() || DEFAULT_MEMORIES_BASE).replace(/\/+$/, '');
  const apiKey = env.MEMORIES_API_KEY?.trim() ?? '';
  const timeoutMs = Number(env.MEMORIES_TIMEOUT_MS ?? 30_000) || 30_000;

  async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: apiKey, Accept: 'application/json' };
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
    if (init.body && !isForm && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const d = (data ?? {}) as Record<string, unknown>;
      const err = (d.error && typeof d.error === 'object' ? d.error : d) as Record<string, unknown>;
      const code = typeof err.code === 'string' ? err.code : undefined;
      const message = typeof err.message === 'string' ? err.message : `Memories.ai ${res.status} on ${path}`;
      throw new MemoriesError(res.status, message, code, data);
    }
    return data as T;
  }

  const client: MemoriesClient = {
    stubbed,
    base,

    async uploadVideo({ file, filename, orderId, collectionId, fps }) {
      const collection = collectionId ?? env.MEMORIES_CLAIMS_COLLECTION ?? '';
      if (stubbed) {
        const map = (uploadStubs as { order_to_video: Record<string, string>; default: { video_id: string } });
        const videoId = map.order_to_video[orderId] ?? map.default.video_id;
        const operation = `op_stub_${Date.now()}__${videoId}`;
        logger.log(`[stub] upload ${filename} (${file.size} bytes) for order ${orderId} → ${videoId} / ${operation}`);
        return { video_id: videoId, operation, status: 'processing' };
      }
      if (!collection) throw new MemoriesError(400, 'MEMORIES_CLAIMS_COLLECTION is not configured', 'collection_missing');
      const form = new FormData();
      form.append('json', JSON.stringify({ collection_id: collection, fps: fps ?? 1, metadata: { title: orderId } }));
      form.append('file', file, filename);
      const data = await request<{ video_id: string; operation: string; status?: string }>('/videos', {
        method: 'POST', body: form, timeoutMs: Math.max(timeoutMs, 120_000),
      });
      return { video_id: data.video_id, operation: data.operation, status: data.status };
    },

    async getOperation(operation) {
      if (stubbed) return stubOperation(operation, env);
      return request<OperationStatus>(`/operations/${encodeURIComponent(operation)}`);
    },

    async getSummary(videoId) {
      if (stubbed) return pickStub<{ summary: string }>(summaryStubs, videoId).summary;
      const data = await request<{ summary?: string }>(`/videos/${encodeURIComponent(videoId)}/summary`);
      return typeof data.summary === 'string' ? data.summary : '';
    },

    async getCaption(videoId) {
      const data = stubbed
        ? pickStub<{ caption?: string; segments?: CaptionSegment[]; aggregated?: string }>(captionStubs, videoId)
        : await request<{ caption?: string; segments?: CaptionSegment[]; aggregated?: string }>(
          `/videos/${encodeURIComponent(videoId)}/caption`,
        );
      const segments = Array.isArray(data.segments)
        ? data.segments
          .filter(s => s && typeof s.text === 'string')
          .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text }))
        : [];
      const text = (typeof data.caption === 'string' && data.caption)
        || (typeof data.aggregated === 'string' && data.aggregated)
        || segments.map(s => s.text).join(' ');
      return { text, segments };
    },

    async getMoment(videoId, start, end, expand) {
      const data = stubbed
        ? pickStub<MomentView>(momentStubs, videoId)
        : await request<Partial<MomentView>>(
          `/moments/${encodeURIComponent(`${videoId}@${start}-${end}`)}?expand=${encodeURIComponent(expand.join(','))}`,
        );
      return {
        ref: data.ref ?? `${videoId}@${start}-${end}`,
        caption: Array.isArray(data.caption) ? data.caption : [],
        frames: Array.isArray(data.frames) ? data.frames.filter(f => f && typeof f.url === 'string') : [],
        clip_url: data.clip_url,
      };
    },

    async searchByImage({ collectionId, imageUrl, topK }) {
      const data = stubbed
        ? pickStub<{ results?: SearchHit[] }>(searchStubs, videoIdFromFrameUrl(imageUrl))
        : await request<{ results?: SearchHit[] }>('/search', {
          method: 'POST',
          body: JSON.stringify({
            collection_id: collectionId,
            query_images: [imageUrl],
            targets: ['frame_embedding'],
            top_k: topK ?? 10,
          }),
        });
      return (Array.isArray(data.results) ? data.results : [])
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          ...r,
          video_id: r.video_id || (typeof r.ref === 'string' ? r.ref.split('@')[0] : ''),
          score: Number(r.score) || 0,
        }))
        .filter(r => !!r.video_id);
    },
  };

  return client;
}
