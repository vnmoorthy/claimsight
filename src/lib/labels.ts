/**
 * Product-facing labels for things the backend describes technically.
 *
 * The backend is growing `display_id`, `customer_name`, `evidence_frame_url`
 * and `mode_label`; every helper here prefers the backend's value and falls
 * back to something presentable derived from the raw fields, so the UI reads
 * the same before and after those fields land.
 */

import type { MessageKeys } from '../i18n';

type Translate = (key: MessageKeys) => string;

interface IdSource {
  display_id?: string;
  claim_id?: string;
  order_id?: string;
}

interface CustomerSource {
  customer_name?: string;
  customer_id?: string;
}

interface FrameSource {
  evidence_frame_url?: string;
  video_id?: string;
}

/**
 * Human-friendly claim number. Backend `display_id` wins; otherwise the same
 * shape is synthesised from the order and the claim id's last four characters
 * ("C-A1043-F809"); otherwise the raw id is shown whole (never middle-ellipsed).
 */
export function displayIdOf(x: IdSource | null | undefined): string | undefined {
  if (!x) return undefined;
  if (x.display_id) return x.display_id;
  if (!x.claim_id) return undefined;
  const tail = x.claim_id.slice(-4);
  if (x.order_id && /^[0-9a-z]{4}$/i.test(tail)) return `C-${x.order_id.toUpperCase()}-${tail.toUpperCase()}`;
  return x.claim_id;
}

/** Backend `display_id` for a fraud match, else the whole raw claim id (never middle-ellipsed). */
export function matchIdOf(m: IdSource | null | undefined): string | undefined {
  if (!m) return undefined;
  return m.display_id ?? m.claim_id;
}

/**
 * Customer's name. Backend `customer_name` wins; a readable id such as
 * `c_alice` becomes "Alice"; anything else is shown as the raw id.
 */
export function customerNameOf(x: CustomerSource | null | undefined): string | undefined {
  if (!x) return undefined;
  if (x.customer_name) return x.customer_name;
  const id = x.customer_id;
  if (!id) return undefined;
  const bare = id.replace(/^(c|cust|customer)[_-]/i, '');
  if (/^[a-z]+$/i.test(bare) && bare.length >= 2) return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
  return id;
}

/** True when the name is just the raw id (so the small id line would repeat it). */
export function hasCustomerName(x: CustomerSource | null | undefined): boolean {
  const name = customerNameOf(x);
  return Boolean(name && name !== x?.customer_id);
}

/**
 * Decision mode. Backend `mode_label` wins; `deterministic` → "Policy engine",
 * `llm` → "AI model", a bare model name → "AI model · <model>".
 */
export function modeLabelOf(t: Translate, explicit?: string | null, raw?: string | null): string | undefined {
  if (explicit) return explicit;
  const mode = (raw ?? '').trim();
  if (!mode) return undefined;
  const key = mode.toLowerCase();
  if (key === 'deterministic' || key === 'policy' || key === 'rules' || key === 'policy_engine') return t('mode.policy');
  if (key === 'llm' || key === 'model' || key === 'ai' || key === 'agent') return t('mode.ai');
  return `${t('mode.ai')} · ${mode}`;
}

/**
 * Still frame for the evidence clip. Backend `evidence_frame_url` wins; the
 * bundled demo clips have frames under /evidence/frames/<video_id>/3.jpg.
 * Callers hide the image on error, so a missing frame costs nothing.
 */
export function evidenceFrameUrlOf(x: FrameSource | null | undefined): string | undefined {
  if (!x) return undefined;
  if (x.evidence_frame_url) return x.evidence_frame_url;
  if (x.video_id && /^vid_stub_/i.test(x.video_id)) return `/evidence/frames/${encodeURIComponent(x.video_id)}/3.jpg`;
  return undefined;
}

/** "Demo data" | "Live" for the top-bar pill, derived when the backend has not labelled itself yet. */
export function backendLabelOf(t: Translate, status: { backendLabel?: string; backend?: string; memoriesStubbed?: boolean }): { label: string; tone: 'demo' | 'live' | 'neutral' } {
  const raw = (status.backendLabel ?? '').trim();
  const key = raw.toLowerCase();
  if (key === 'live') return { label: t('status.dataLive'), tone: 'live' };
  if (key === 'demo data' || key === 'demo') return { label: t('status.demoData'), tone: 'demo' };
  if (raw) return { label: raw, tone: 'neutral' };
  const demo = status.memoriesStubbed === true || (status.backend ?? '').toLowerCase() === 'memory';
  return demo ? { label: t('status.demoData'), tone: 'demo' } : { label: t('status.dataLive'), tone: 'live' };
}

/** JS smooth scrolling ignores the CSS reduced-motion override, so ask explicitly. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
