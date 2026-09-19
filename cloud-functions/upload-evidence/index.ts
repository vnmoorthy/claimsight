/**
 * Evidence upload proxy — EdgeOne Makers Node Function
 * ====================================================
 *
 * File path cloud-functions/upload-evidence/index.ts maps to **POST /upload-evidence**.
 *
 * multipart/form-data: `file` (mp4/mov/webm), `order_id`. Proxies to Memories.ai
 * `POST {MEMORIES_BASE}/videos` as multipart (`json` part = { collection_id, fps: 1,
 * metadata: { title: order_id } }, `file` part) and returns `{ video_id, operation }`.
 * The browser never sees MEMORIES_API_KEY. With MEMORIES_STUB=1 (or no key) the stub maps the
 * order id onto a canned video id and a time-progressing operation.
 *
 * Note: Makers cloud functions accept request bodies up to 6 MB — larger clips should be
 * pre-indexed (see README "Pre-indexing evidence") and selected from the demo dropdown.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import { archiveEvidence, isArchiveEnabled, type ArchiveResult } from '../_archive';
import { resolveEnv, jsonResponse, errorResponse } from '../_kv';
import { createMemoriesClient, MemoriesError } from '../_memories';

const logger = createLogger('upload-evidence');

function conversationHeader(context: CloudFunctionContext): string | undefined {
  const h = (context.request as unknown as { headers?: { get?: (k: string) => string | null } })?.headers;
  const v = typeof h?.get === 'function' ? h.get('makers-conversation-id') : null;
  return v ?? undefined;
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const VIDEO_MIME = /^video\//i;

async function readForm(context: CloudFunctionContext): Promise<FormData | null> {
  const req = context.request as unknown as { formData?: () => Promise<FormData>; body?: unknown } | undefined;
  if (!req) return null;
  try {
    const pre = await req.body;
    if (typeof FormData !== 'undefined' && pre instanceof FormData) return pre;
  } catch { /* ignore */ }
  try {
    if (typeof req.formData === 'function') return await req.formData();
  } catch (e) {
    logger.error('[upload-evidence] formData() failed:', e);
  }
  return null;
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const form = await readForm(context);
  if (!form) return errorResponse(400, 'invalid_request', 'multipart/form-data body with `file` and `order_id` is required');

  const orderId = String(form.get('order_id') ?? '').trim();
  const file = form.get('file');
  if (!orderId) return errorResponse(400, 'invalid_request', "'order_id' is required");
  if (!(file instanceof Blob) || file.size === 0) return errorResponse(400, 'invalid_request', "'file' must be a non-empty video file");

  const filename = (file as File).name || `evidence-${orderId}.mp4`;
  const mime = file.type || '';
  if (!(VIDEO_EXT.test(filename) || VIDEO_MIME.test(mime))) {
    return errorResponse(415, 'unsupported_media', 'Upload an mp4, mov or webm video', { filename, mime });
  }
  const maxBytes = Number(env.MAX_UPLOAD_BYTES ?? 6 * 1024 * 1024) || 6 * 1024 * 1024;
  if (file.size > maxBytes) {
    return errorResponse(413, 'file_too_large', `Clip is ${file.size} bytes; the limit is ${maxBytes}. Pre-index larger clips and use the demo dropdown.`, { size: file.size, limit: maxBytes });
  }

  const client = createMemoriesClient(env);
  try {
    const result = await client.uploadVideo({ file, filename, orderId });
    logger.log(`[upload-evidence] order=${orderId} file=${filename} size=${file.size} stub=${client.stubbed} → ${result.video_id}`);
    // Optional durable copy on AWS S3 (no-op unless AWS_S3_BUCKET is configured; never blocks the claim).
    let archive: ArchiveResult = { archived: false, reason: 'AWS_S3_BUCKET not set' };
    if (isArchiveEnabled(env)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      archive = await archiveEvidence({ env, bytes, filename, mime, orderId, videoId: result.video_id, conversationId: conversationHeader(context) });
    }
    return jsonResponse({
      video_id: result.video_id,
      operation: result.operation,
      status: result.status ?? 'processing',
      order_id: orderId,
      filename,
      size: file.size,
      stubbed: client.stubbed,
      archive: archive.archived ? { archived: true, bucket: archive.bucket, key: archive.key } : { archived: false },
    }, 202);
  } catch (e) {
    if (e instanceof MemoriesError) {
      logger.error(`[upload-evidence] memories ${e.status} ${e.code ?? ''}: ${e.message}`);
      return errorResponse(e.status >= 500 ? 502 : e.status, e.code ?? 'memories_error', e.message);
    }
    logger.error('[upload-evidence] failed:', e);
    return errorResponse(502, 'upload_failed', e instanceof Error ? e.message : String(e));
  }
}
