/**
 * Damage Twin helpers. The backend attaches `twin` to claim records, list
 * items and the decision block; a card may see the same twin from several of
 * those sources at different moments, so `mergeTwin` keeps the most advanced
 * one (a `ready` from the record beats a `queued` from an old decision block).
 */

import type { DamageTwin, TwinStatus } from '../types';

const RANK: Record<TwinStatus, number> = { queued: 0, rendering: 1, failed: 2, unavailable: 2, ready: 3 };

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function stamp(v: unknown): string | number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return str(v);
}

/** Collapse whatever spelling the backend used onto the five statuses. */
export function twinStatusOf(raw: unknown): TwinStatus | null {
  const s = (typeof raw === 'string' ? raw : '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'queued' || s === 'pending' || s === 'requested') return 'queued';
  if (s === 'rendering' || s === 'running' || s === 'in_progress' || s === 'processing') return 'rendering';
  if (s === 'ready' || s === 'done' || s === 'complete' || s === 'completed' || s === 'succeeded') return 'ready';
  if (s === 'failed' || s === 'error' || s === 'errored') return 'failed';
  if (s === 'unavailable' || s === 'skipped' || s === 'disabled' || s === 'none') return 'unavailable';
  return null;
}

/** Coerce a backend `twin` value into a DamageTwin; undefined when there is none. */
export function normalizeTwin(raw: unknown): DamageTwin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const videoUrl = str(o.video_url) ?? str(o.videoUrl) ?? str(o.url);
  const status = twinStatusOf(o.status) ?? (videoUrl ? 'ready' : null);
  if (!status) return undefined;
  const twin: DamageTwin = { status };
  if (videoUrl) twin.video_url = videoUrl;
  const poster = str(o.poster_url) ?? str(o.posterUrl) ?? str(o.poster);
  if (poster) twin.poster_url = poster;
  const requested = stamp(o.requested_at ?? o.requestedAt);
  if (requested !== undefined) twin.requested_at = requested;
  const ready = stamp(o.ready_at ?? o.readyAt);
  if (ready !== undefined) twin.ready_at = ready;
  const renderMs = num(o.render_ms ?? o.renderMs);
  if (renderMs !== undefined) twin.render_ms = renderMs;
  const error = str(o.error) ?? (o.error && typeof o.error === 'object' ? str((o.error as Record<string, unknown>).message) : undefined);
  if (error) twin.error = error;
  return twin;
}

export function isTwinPending(twin: DamageTwin | null | undefined): boolean {
  return !!twin && (twin.status === 'queued' || twin.status === 'rendering');
}

/** True when the block should render at all (queued/rendering/ready/failed; never for unavailable). */
export function isTwinVisible(twin: DamageTwin | null | undefined): boolean {
  return !!twin && twin.status !== 'unavailable';
}

/** The more advanced of two sightings of the same twin; on a tie the newer (`b`) wins. */
export function mergeTwin(a: DamageTwin | undefined, b: DamageTwin | undefined): DamageTwin | undefined {
  if (!a) return b;
  if (!b) return a;
  if (RANK[b.status] >= RANK[a.status]) return { ...a, ...b };
  return { ...b, ...a };
}
