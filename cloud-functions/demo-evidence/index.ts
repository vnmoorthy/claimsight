/**
 * Demo evidence list — EdgeOne Makers Node Function
 * =================================================
 *
 * File path cloud-functions/demo-evidence/index.ts maps to **GET /demo-evidence**.
 *
 * Serves data/demo_evidence.json (`[{ label, video_id, order_id }]`) for the "Use demo clip"
 * dropdown, so the UI and the Memories.ai stubs always agree on the video ids. Replace the
 * placeholder ids with real `vid_…` ids after pre-indexing (README → "Pre-indexing evidence").
 */

import type { CloudFunctionContext } from '@edgeone/types';
import demoEvidence from '../../data/demo_evidence.json';
import { resolveEnv, jsonResponse, isMemoriesStubbed } from '../_kv';

interface DemoClip { label: string; video_id: string; order_id: string; note?: string }

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const env = resolveEnv(context.env);
  const items = (demoEvidence as DemoClip[]).filter(c => c && typeof c.video_id === 'string' && typeof c.label === 'string');
  return jsonResponse({
    items,
    count: items.length,
    memories_stubbed: isMemoriesStubbed(env),
    note: isMemoriesStubbed(env)
      ? 'Memories.ai is stubbed: these ids resolve to canned summaries/captions in data/stubs/.'
      : 'Live Memories.ai: ids must be videos already indexed in MEMORIES_CLAIMS_COLLECTION.',
  }, 200, { 'Cache-Control': 'no-store' });
}
