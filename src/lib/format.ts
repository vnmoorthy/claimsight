/** Small, dependency-free formatting helpers shared by the chat and the desk. */

export function fmtMoney(amount?: number | null, currency = 'USD'): string {
  if (amount === undefined || amount === null || !Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function fmtLatency(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtPercent(ratio?: number | null): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** Accepts ISO strings, epoch seconds or epoch millis. */
export function toMillis(ts?: string | number | null): number | undefined {
  if (ts === undefined || ts === null || ts === '') return undefined;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return undefined;
    return ts < 1e12 ? ts * 1000 : ts;       // seconds vs millis
  }
  const asNum = Number(ts);
  if (Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(ts.trim())) return toMillis(asNum);
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function fmtRelative(ts?: string | number | null, now: number = Date.now()): string {
  const ms = toMillis(ts);
  if (ms === undefined) return '—';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  if (diff < 45_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  const days = Math.round(diff / (24 * 60 * 60_000));
  if (days < 45) return `${days}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtClock(ts?: string | number | null): string {
  const ms = toMillis(ts);
  if (ms === undefined) return '—';
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function truncate(s: string | undefined | null, max: number): string {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function shortId(id: string | undefined | null, head = 10, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function median(values: number[]): number | undefined {
  const nums = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
