import type { DemoEvidence } from './types';

/**
 * "Use demo clip" sources, in order of preference:
 *   1. GET /demo-evidence at runtime (when the backend serves it);
 *   2. data/demo_evidence.json, inlined into the bundle at build time — the
 *      same file the backend seeds its Memories.ai stubs from, so the ids
 *      always line up with `MEMORIES_STUB=1`;
 *   3. the inline list below, only if that file is missing at build time.
 */
const bundled = import.meta.glob('../data/demo_evidence.json', { eager: true, import: 'default' });

const INLINE_FALLBACK: DemoEvidence[] = [
  { label: 'Chipped mug — A1042 (clean auto-approve)', video_id: 'vid_stub_mug_alice', order_id: 'A1042' },
  { label: 'Same mug footage, other account — A1043 (fraud twin)', video_id: 'vid_stub_mug_mallory', order_id: 'A1043' },
  { label: 'Cracked headphones — A1050 (above $75 limit)', video_id: 'vid_stub_headphones_crack', order_id: 'A1050' },
  { label: 'Dented desk lamp — A1061 (outside 30-day window)', video_id: 'vid_stub_lamp_dent', order_id: 'A1061' },
  { label: 'Worn t-shirt — A1077 (non-returnable)', video_id: 'vid_stub_tshirt_worn', order_id: 'A1077' },
];

function coerce(raw: unknown): DemoEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map(x => ({
      label: typeof x.label === 'string' ? x.label : '',
      video_id: typeof x.video_id === 'string' ? x.video_id : '',
      order_id: typeof x.order_id === 'string' ? x.order_id : '',
      note: typeof x.note === 'string' ? x.note : undefined,
    }))
    .filter(x => x.label && x.video_id);
}

const fromFile = coerce(Object.values(bundled)[0]);

export const DEMO_EVIDENCE_FALLBACK: DemoEvidence[] = fromFile.length > 0 ? fromFile : INLINE_FALLBACK;

/**
 * Human label for a demo clip id ("Chipped mug — A1042 (clean auto-approve)").
 * Two demo entries can share footage (the fraud-twin scenario), so the order
 * disambiguates when known. Returns undefined for uploaded (non-demo) clips.
 */
export function demoClipLabel(videoId?: string | null, orderId?: string | null): string | undefined {
  if (!videoId) return undefined;
  const exact = orderId ? DEMO_EVIDENCE_FALLBACK.find(d => d.video_id === videoId && d.order_id.toUpperCase() === orderId.toUpperCase()) : undefined;
  return (exact ?? DEMO_EVIDENCE_FALLBACK.find(d => d.video_id === videoId))?.label;
}
