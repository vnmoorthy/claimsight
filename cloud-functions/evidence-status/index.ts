/**
 * Evidence indexing status — EdgeOne Makers Node Function
 * =======================================================
 *
 * File path cloud-functions/evidence-status/index.ts maps to **POST /evidence-status**
 * (also GET /evidence-status?operation=…&video_id=…).
 *
 * Body `{ operation, video_id }` → polls Memories.ai `GET /operations/{op}`; when done, fetches
 * `GET /videos/{id}/summary` and `/caption` and returns `{ done, progress, stage, summary?,
 * caption? }`. The UI polls this every 2 s to drive the "preprocess → index → derive" pill.
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import {
  resolveEnv, readJsonBody, jsonResponse, errorResponse, getQuery, queryString, pickString,
} from '../_kv';
import { createMemoriesClient, MemoriesError, type OperationStatus } from '../_memories';

const logger = createLogger('evidence-status');

type Stage = 'preprocess' | 'index' | 'derive' | 'ready' | 'failed';

function stageOf(op: OperationStatus): Stage {
  if (op.error) return 'failed';
  if (op.done) return 'ready';
  const p = op.progress ?? {};
  if (p.preprocess !== 'done') return 'preprocess';
  if (p.index !== 'done') return 'index';
  return 'derive';
}

async function status(context: CloudFunctionContext, operation: string, videoId: string): Promise<Response> {
  if (!operation && !videoId) return errorResponse(400, 'invalid_request', "'operation' (and ideally 'video_id') is required");
  const env = resolveEnv(context.env);
  const client = createMemoriesClient(env);

  try {
    const op: OperationStatus = operation
      ? await client.getOperation(operation)
      : { operation: '', done: true, progress: { preprocess: 'done', index: 'done', derive: 'done', percent: 100 }, error: null };
    const resolvedVideo = videoId || (op.resource && op.resource.startsWith('vid_') ? op.resource : '');
    let stage = stageOf(op);

    if (op.error) {
      logger.log(`[evidence-status] op=${operation} failed: ${op.error.code}`);
      return jsonResponse({ done: true, failed: true, stage, progress: op.progress, error: op.error, operation, video_id: resolvedVideo, stubbed: client.stubbed });
    }
    if (!op.done) {
      return jsonResponse({ done: false, stage, progress: op.progress, operation, video_id: resolvedVideo, stubbed: client.stubbed });
    }

    let summary: string | undefined;
    let caption: { text: string; segments: Array<{ start: number; end: number; text: string }> } | undefined;
    if (resolvedVideo) {
      try {
        [summary, caption] = await Promise.all([client.getSummary(resolvedVideo), client.getCaption(resolvedVideo)]);
      } catch (e) {
        if (e instanceof MemoriesError && e.status === 409) {
          // Operation says done but derived content is still materialising — keep polling.
          stage = 'derive';
          return jsonResponse({ done: false, stage, progress: { ...op.progress, derive: 'running', percent: 99 }, operation, video_id: resolvedVideo, stubbed: client.stubbed, note: 'video_not_ready' });
        }
        throw e;
      }
    }
    logger.log(`[evidence-status] op=${operation} video=${resolvedVideo} ready stub=${client.stubbed}`);
    return jsonResponse({
      done: true,
      stage: 'ready',
      progress: op.progress ?? { preprocess: 'done', index: 'done', derive: 'done', percent: 100 },
      operation,
      video_id: resolvedVideo,
      summary,
      caption: caption?.text,
      caption_segments: caption?.segments,
      stubbed: client.stubbed,
    });
  } catch (e) {
    if (e instanceof MemoriesError) {
      logger.error(`[evidence-status] memories ${e.status} ${e.code ?? ''}: ${e.message}`);
      return errorResponse(e.status >= 500 ? 502 : e.status, e.code ?? 'memories_error', e.message);
    }
    logger.error('[evidence-status] failed:', e);
    return errorResponse(502, 'status_failed', e instanceof Error ? e.message : String(e));
  }
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const body = await readJsonBody(context);
  return status(context, pickString(body, 'operation', 'op'), pickString(body, 'video_id', 'videoId'));
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const q = getQuery(context);
  return status(context, queryString(q, 'operation') ?? '', queryString(q, 'video_id') ?? '');
}
