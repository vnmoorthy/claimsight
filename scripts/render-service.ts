/**
 * ClaimSight Damage Twin render service — a local / EC2 sidecar (not a cloud function).
 *
 *   npm run render:service          (= npx tsx scripts/render-service.ts)  →  http://localhost:8090
 *
 *   GET  /health                     → {ok, blender:{found, path}, queue}
 *   POST /render/twin                {claim_id, spec} → 202 {job_id, status:"queued"}  (one Blender at a time)
 *   GET  /render/status/<claim_id>   → {status, video_url?, poster_url?, error?}
 *
 * Every job runs blender/damage_twin.py headless with the spec the agent built (product proxy, damage
 * marker, evidence frame + decision HUD), writes public/twins/<claim_id>.mp4 + .png, then POSTs
 * ${CLAIMSIGHT_URL}/twin-ready — {claim_id, video_url, poster_url, render_ms} on success or
 * {claim_id, error} on failure — so the claim record flips to twin.status "ready" / "failed".
 *
 * Env: RENDER_PORT (8090) · BLENDER_BIN (/Applications/Blender.app/Contents/MacOS/Blender, or `blender` on
 * PATH) · CLAIMSIGHT_URL (http://localhost:8088) · ADMIN_TOKEN (forwarded as x-admin-token) ·
 * TWIN_WIDTH / TWIN_HEIGHT / TWIN_FPS / TWIN_DURATION / TWIN_SAMPLES (800×450 · 20 fps · 4 s · 12 samples) ·
 * TWIN_RENDER_TIMEOUT_MS (600000) · TWIN_MAX_QUEUE (8 pending jobs; beyond that POST /render/twin answers
 * 429 {error:"queue_full"} so a runaway loop can never block a stage demo).
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CLAIMSIGHT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RENDER_PORT ?? 8090) || 8090;
const CLAIMSIGHT_URL = (process.env.CLAIMSIGHT_URL?.trim() || 'http://localhost:8088').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim();
const SCRIPT = path.join(ROOT, 'blender', 'damage_twin.py');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'twins');
const RENDER_TIMEOUT_MS = Number(process.env.TWIN_RENDER_TIMEOUT_MS ?? 600_000) || 600_000;
const MAX_QUEUE = Math.max(1, Math.floor(Number(process.env.TWIN_MAX_QUEUE ?? 8) || 8));

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const DEFAULTS = {
  width: Math.round(num(process.env.TWIN_WIDTH, 800)),
  height: Math.round(num(process.env.TWIN_HEIGHT, 450)),
  fps: Math.round(num(process.env.TWIN_FPS, 20)),
  duration_s: num(process.env.TWIN_DURATION, 4),
  samples: Math.round(num(process.env.TWIN_SAMPLES, 12)),
};

/** BLENDER_BIN, else the macOS app bundle binary, else `blender` on PATH. */
function resolveBlender(): { found: boolean; path: string } {
  const candidates = [process.env.BLENDER_BIN?.trim(), '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter((c): c is string => !!c);
  for (const cand of candidates) {
    if (cand.includes(path.sep) || cand.includes('/')) {
      if (fs.existsSync(cand)) return { found: true, path: cand };
      continue;
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const full = path.join(dir, cand);
      if (dir && fs.existsSync(full)) return { found: true, path: full };
    }
  }
  return { found: false, path: candidates[0] };
}

type JobStatus = 'queued' | 'rendering' | 'ready' | 'failed';

interface Job {
  job_id: string;
  claim_id: string;
  spec: Record<string, unknown>;
  status: JobStatus;
  queued_at: number;
  started_at?: number;
  finished_at?: number;
  render_ms?: number;
  blender_ms?: number;
  video_url?: string;
  poster_url?: string;
  error?: string;
  skipped?: boolean;
}

const jobs = new Map<string, Job>(); // latest job per claim_id
const queue: Job[] = [];
let running: Job | null = null;
let child: ChildProcess | null = null;
const stats = { done: 0, failed: 0 };

const ts = () => new Date().toISOString();
const log = (line: string) => console.log(`[render] ${ts()} ${line}`);
const secs = (ms: number | undefined) => `${((ms ?? 0) / 1000).toFixed(1)}s`;

class JobSkipped extends Error {}

// ── Blender ───────────────────────────────────────────────────────────────

function runBlender(bin: string, args: string[]): Promise<{ code: number | null; tail: string }> {
  return new Promise(resolve => {
    const lines: string[] = [];
    const keep = (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split('\n')) {
        const line = l.trim();
        if (!line || /^Fra:\d+/.test(line)) continue; // per-frame progress noise
        lines.push(line);
        if (lines.length > 60) lines.shift();
      }
    };
    const proc = spawn(bin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, RENDER_TIMEOUT_MS);
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('error', err => { lines.push(`spawn failed: ${err.message}`); });
    proc.on('close', code => {
      clearTimeout(timer);
      child = null;
      if (timedOut) lines.push(`killed after ${RENDER_TIMEOUT_MS} ms`);
      const interesting = lines.filter(l => /error|traceback|exception|killed|usage:|no frames|spawn failed/i.test(l));
      resolve({ code: timedOut ? -1 : code, tail: (interesting.length ? interesting : lines).slice(-6).join(' | ').slice(0, 700) });
    });
  });
}

/** The customer's frame for the HUD: http(s) → download; "/evidence/…" → public/; absolute path → as is. */
async function resolveFrame(spec: Record<string, unknown>, tmp: string): Promise<string | undefined> {
  const framePath = typeof spec.frame_path === 'string' ? spec.frame_path : '';
  if (framePath && path.isAbsolute(framePath) && fs.existsSync(framePath)) return framePath;
  const url = typeof spec.frame_url === 'string' ? spec.frame_url.trim() : '';
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ext = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? (res.headers.get('content-type')?.includes('png') ? 'png' : 'jpg');
      const file = path.join(tmp, `frame.${ext === 'jpeg' ? 'jpg' : ext}`);
      await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (e) {
      log(`frame download failed (${url}): ${e instanceof Error ? e.message : String(e)} — rendering without the customer frame`);
      return undefined;
    }
  }
  if (url.startsWith('/')) {
    const local = path.resolve(PUBLIC_DIR, `.${url.split('?')[0]}`);
    if (local.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(local)) return local;
    // Not on this disk (e.g. the UI host serves it): try the backend, which also serves public/.
    try {
      const res = await fetch(`${CLAIMSIGHT_URL}${url}`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const file = path.join(tmp, `frame${path.extname(url.split('?')[0]) || '.jpg'}`);
        await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
        return file;
      }
    } catch { /* fall through */ }
    log(`frame not found for ${url} — rendering without the customer frame`);
  }
  return undefined;
}

// ── ClaimSight callbacks ──────────────────────────────────────────────────

async function notify(payload: Record<string, unknown>, attempts: number): Promise<{ ok: boolean; status: number; detail?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN;
  let last: { ok: boolean; status: number; detail?: string } = { ok: false, status: 0 };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${CLAIMSIGHT_URL}/twin-ready`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      last = { ok: res.ok, status: res.status, detail: res.ok ? undefined : text.slice(0, 200) };
      // 404: the record is not written yet (record_decision persists right after asking us) — retry.
      if (res.ok || res.status !== 404) return last;
    } catch (e) {
      last = { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
    }
    if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
  }
  return last;
}

/** true / false when the backend answers, null when it cannot be asked (then we render anyway). */
async function claimExists(claimId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${CLAIMSIGHT_URL}/claim?claim_id=${encodeURIComponent(claimId)}`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

// ── Queue ─────────────────────────────────────────────────────────────────

async function runJob(job: Job): Promise<void> {
  job.status = 'rendering';
  job.started_at = Date.now();
  void notify({ claim_id: job.claim_id, status: 'rendering' }, 1); // best effort: "rendering" on the record
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'claimsight-twin-'));
  const blender = resolveBlender();
  try {
    // The demo store is re-seeded often; do not spend 25 s on a claim that no longer exists.
    if ((await claimExists(job.claim_id)) === false) throw new JobSkipped('claim no longer exists on the backend');
    if (!blender.found) throw new Error(`Blender not found at ${blender.path} (set BLENDER_BIN)`);
    const framePath = await resolveFrame(job.spec, tmp);
    const { frame_url: _frameUrl, frame_path: _framePath, ...rest } = job.spec;
    void _frameUrl; void _framePath;
    const spec = { ...DEFAULTS, ...rest, ...(framePath ? { frame_path: framePath } : {}) };
    const specPath = path.join(tmp, 'spec.json');
    await fsp.writeFile(specPath, JSON.stringify(spec, null, 2));
    const partialMp4 = path.join(tmp, 'twin.mp4');
    const partialPng = path.join(tmp, 'twin.png');
    const t0 = Date.now();
    const result = await runBlender(blender.path, ['-b', '-P', SCRIPT, '--', '--spec', specPath, '--out', partialMp4, '--poster', partialPng]);
    job.blender_ms = Date.now() - t0;
    if (result.code !== 0 || !fs.existsSync(partialMp4)) {
      throw new Error(`blender exited ${result.code}${result.tail ? `: ${result.tail}` : ''}`);
    }
    await fsp.mkdir(OUT_DIR, { recursive: true });
    await fsp.copyFile(partialMp4, path.join(OUT_DIR, `${job.claim_id}.mp4`));
    if (fs.existsSync(partialPng)) await fsp.copyFile(partialPng, path.join(OUT_DIR, `${job.claim_id}.png`));
    job.status = 'ready';
    job.video_url = `/twins/${job.claim_id}.mp4`;
    job.poster_url = fs.existsSync(partialPng) ? `/twins/${job.claim_id}.png` : undefined;
  } catch (e) {
    job.status = 'failed';
    job.skipped = e instanceof JobSkipped;
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    job.finished_at = Date.now();
    job.render_ms = job.finished_at - job.started_at;
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  if (job.skipped) {
    log(`job=${job.job_id} claim=${job.claim_id} skipped (${job.error}) total=${secs(job.render_ms)}`);
    return;
  }
  const payload = job.status === 'ready'
    ? { claim_id: job.claim_id, video_url: job.video_url, poster_url: job.poster_url, render_ms: job.render_ms }
    : { claim_id: job.claim_id, error: job.error, render_ms: job.render_ms };
  const cb = await notify(payload, 4);
  if (job.status === 'ready') stats.done++; else stats.failed++;
  const spec = job.spec;
  log(`job=${job.job_id} claim=${job.claim_id} ${spec.product ?? 'generic'} ${spec.damage_type ?? 'damage'}@${spec.damage_location ?? '-'} `
    + `status=${job.status} total=${secs(job.render_ms)} blender=${secs(job.blender_ms)}`
    + (job.video_url ? ` -> ${job.video_url}` : '') + (job.error ? ` error="${job.error}"` : '')
    + ` callback=${cb.ok ? 'ok' : `failed(${cb.status}${cb.detail ? ` ${cb.detail}` : ''})`}`);
}

function pump(): void {
  if (running || !queue.length) return;
  running = queue.shift()!;
  runJob(running).catch(e => log(`job=${running?.job_id} crashed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => {
    running = null;
    pump();
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    if (method === 'OPTIONS') { send(res, 204, {}); return; }
    if (method === 'GET' && url.pathname === '/health') {
      const blender = resolveBlender();
      send(res, 200, {
        ok: true, blender, queue: queue.length + (running ? 1 : 0), pending: queue.length, max_queue: MAX_QUEUE, rendering: running?.claim_id ?? null,
        done: stats.done, failed: stats.failed, out_dir: OUT_DIR, claimsight_url: CLAIMSIGHT_URL, defaults: DEFAULTS,
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/render/twin') {
      const body = await readJson(req);
      const claimId = typeof body.claim_id === 'string' ? body.claim_id.trim() : '';
      const spec = body.spec && typeof body.spec === 'object' && !Array.isArray(body.spec) ? body.spec as Record<string, unknown> : null;
      if (!CLAIM_ID_RE.test(claimId)) { send(res, 400, { error: 'invalid_claim_id', message: "'claim_id' must be a safe identifier" }); return; }
      if (!spec) { send(res, 400, { error: 'invalid_spec', message: "'spec' object is required" }); return; }
      const blender = resolveBlender();
      if (!blender.found) { send(res, 503, { error: 'blender_not_found', message: `Blender not found at ${blender.path} (set BLENDER_BIN)` }); return; }
      const existing = jobs.get(claimId);
      if (existing && (existing.status === 'queued' || existing.status === 'rendering')) {
        send(res, 202, { job_id: existing.job_id, status: existing.status, claim_id: claimId, position: queue.indexOf(existing) + 1 });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        log(`claim=${claimId} rejected: queue full (${queue.length}/${MAX_QUEUE} pending)`);
        send(res, 429, { error: 'queue_full', message: `${queue.length} renders are already pending (max ${MAX_QUEUE})`, queue: queue.length, max_queue: MAX_QUEUE });
        return;
      }
      const job: Job = { job_id: `job_${randomUUID().slice(0, 8)}`, claim_id: claimId, spec, status: 'queued', queued_at: Date.now() };
      jobs.set(claimId, job);
      queue.push(job);
      log(`job=${job.job_id} claim=${claimId} queued (${spec.product ?? 'generic'} ${spec.damage_type ?? 'damage'}@${spec.damage_location ?? '-'}) position=${queue.length}`);
      send(res, 202, { job_id: job.job_id, status: 'queued', claim_id: claimId, position: queue.length });
      pump();
      return;
    }
    const m = /^\/render\/status\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && m) {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) { send(res, 404, { status: 'unknown', error: 'no render job for this claim' }); return; }
      send(res, 200, {
        status: job.status, job_id: job.job_id, claim_id: job.claim_id, video_url: job.video_url, poster_url: job.poster_url,
        error: job.error, render_ms: job.render_ms, queued_at: new Date(job.queued_at).toISOString(),
      });
      return;
    }
    send(res, 404, { error: 'not_found', path: url.pathname });
  } catch (e) {
    send(res, 500, { error: 'render_service_error', message: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  const blender = resolveBlender();
  log(`Damage Twin render service listening on http://localhost:${PORT} (root=${ROOT})`);
  log(`blender=${blender.found ? blender.path : `NOT FOUND (${blender.path})`} claimsight=${CLAIMSIGHT_URL} out=${OUT_DIR} `
    + `defaults=${DEFAULTS.width}x${DEFAULTS.height}@${DEFAULTS.fps}fps ${DEFAULTS.duration_s}s ${DEFAULTS.samples} samples max_queue=${MAX_QUEUE} admin_token=${ADMIN_TOKEN ? 'set' : 'unset'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (child) child.kill('SIGKILL');
    server.close();
    process.exit(0);
  });
}
