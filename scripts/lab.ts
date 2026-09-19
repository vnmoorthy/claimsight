/**
 * ClaimSight Synthetic Evidence Lab — does the fraud-twin detector catch re-filmed evidence?
 *
 *   npm run lab -- --count 24 --seed 7 [--reuse] [--out blender/out/lab] [--twin-rate 1.0] [--damaged-rate 0.7]
 *
 * 1. Renders labelled evidence clips with blender/synth_evidence.py (products with / without damage,
 *    random lighting, backgrounds, handheld camera; every damaged item gets a "twin" re-filmed under
 *    different conditions, sometimes mirrored) unless --reuse and <out>/manifest.json already exist.
 * 2. Scores every ordered pair of clips (a ≠ b) with a detector:
 *      memories.ai    — MEMORIES_API_KEY set and MEMORIES_STUB != 1: upload every clip into the lab
 *                       collection (MEMORIES_LAB_COLLECTION, else a new "claimsight-lab"), wait for
 *                       indexing, then search each clip's first frame against the collection
 *                       (frame embeddings, top_k 10) — the same call the agent's fraud_check makes.
 *      local-baseline — otherwise: a 64-bit dHash + 8×8 mean-colour signature of each poster PNG;
 *                       score = 0.7 · (1 − Hamming/64) + 0.3 · colour similarity, taking the better
 *                       of the plain and horizontally-flipped hash so mirrored twins are not penalised.
 * 3. Sweeps thresholds 0.50 … 0.98 (recall / FPR / precision / F1 over ordered pairs, positive = same
 *    group_id; plus recall on mirrored twins) and recommends the threshold with the best F1.
 * 4. Writes public/lab/results.json, copies posters (+ clips) to public/lab/clips/, prints a table.
 *    eval/lab_eval.py turns results.json into an AgentX dataset + gated run.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoriesClient, DEFAULT_MEMORIES_BASE } from '../cloud-functions/_memories';
import { isMemoriesStubbed, type Env } from '../cloud-functions/_kv';

const ROOT = process.env.CLAIMSIGHT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_LAB = path.join(ROOT, 'public', 'lab');
const TOP_MATCHES = 5;

// ── CLI ───────────────────────────────────────────────────────────────────

interface Options { count: number; seed: number; reuse: boolean; out: string; twin_rate: number; damaged_rate: number }

function parseArgs(argv: string[]): Options {
  const opts: Options = { count: 24, seed: 7, reuse: false, out: 'blender/out/lab', twin_rate: 1.0, damaged_rate: 0.7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--count': opts.count = Math.max(1, Math.floor(Number(next()))); break;
      case '--seed': opts.seed = Math.floor(Number(next())); break;
      case '--reuse': opts.reuse = true; break;
      case '--out': opts.out = String(next()); break;
      case '--twin-rate': opts.twin_rate = Number(next()); break;
      case '--damaged-rate': opts.damaged_rate = Number(next()); break;
      case '-h': case '--help':
        console.log('usage: npm run lab -- [--count 24] [--seed 7] [--reuse] [--out blender/out/lab] [--twin-rate 1.0] [--damaged-rate 0.7]');
        process.exit(0);
    }
  }
  if (!Number.isFinite(opts.count) || !Number.isFinite(opts.seed)) throw new Error('--count and --seed must be numbers');
  return opts;
}

// ── Manifest (ground truth from synth_evidence.py) ────────────────────────

interface ManifestClip {
  clip_id: string;
  file: string;
  product: string;
  damaged: boolean;
  damage_type: string | null;
  damage_location: string | null;
  severity: number;
  group_id: string;
  twin_of: string | null;
  variant: { mirrored: boolean; [k: string]: unknown };
}

interface Manifest { generated_at: string; seed: number; options: Record<string, unknown>; clips: ManifestClip[] }

function resolveBlender(): string {
  const candidates = [process.env.BLENDER_BIN?.trim(), '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter((c): c is string => !!c);
  for (const cand of candidates) {
    if (cand.includes('/')) { if (fs.existsSync(cand)) return cand; continue; }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, cand))) return path.join(dir, cand);
  }
  throw new Error(`Blender not found (tried ${candidates.join(', ')}); set BLENDER_BIN`);
}

/** Run synth_evidence.py, echoing its [lab] progress lines; returns wall-clock seconds. */
async function renderClips(opts: Options, outDir: string): Promise<number> {
  const blender = resolveBlender();
  const args = ['-b', '-P', path.join(ROOT, 'blender', 'synth_evidence.py'), '--', '--out', outDir, '--count', String(opts.count),
    '--seed', String(opts.seed), '--twin-rate', String(opts.twin_rate), '--damaged-rate', String(opts.damaged_rate)];
  console.log(`[lab] rendering ${opts.count} clips with ${blender} (seed ${opts.seed}, twin-rate ${opts.twin_rate}, damaged-rate ${opts.damaged_rate}) → ${outDir}`);
  const t0 = Date.now();
  const tail: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(blender, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.trim();
        if (!line || /^Fra:\d+/.test(line)) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (line.startsWith('[lab]') || /error|traceback/i.test(line)) console.log(`  ${line}`);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`synth_evidence.py exited ${code}: ${tail.slice(-5).join(' | ')}`))));
  });
  return (Date.now() - t0) / 1000;
}

// ── Minimal PNG decoder (8/16-bit, non-interlaced; Blender writes 8-bit RGB) ──

interface Image { width: number; height: number; rgb: Uint8Array }

function decodePng(buf: Buffer): Image {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} not supported`);
  if (colorType === 3 && !palette) throw new Error('paletted PNG without PLTE');
  const bps = bitDepth / 8;
  const bpp = channels * bps;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const base = x * bpp;
      let r: number; let g: number; let b: number;
      switch (colorType) {
        case 2: case 6: r = cur[base]; g = cur[base + bps]; b = cur[base + 2 * bps]; break;
        case 3: { const idx = cur[base] * 3; r = palette![idx]; g = palette![idx + 1]; b = palette![idx + 2]; break; }
        default: r = g = b = cur[base]; // grey (+ alpha)
      }
      const o = (y * width + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgb };
}

// ── Local baseline signatures ─────────────────────────────────────────────

interface Signature { hash: Uint8Array; hashMirror: Uint8Array; color: Float64Array }

/** Mean RGB of the image split into cols × rows cells (row-major, 3 values per cell). */
function gridMeans(img: Image, cols: number, rows: number): Float64Array {
  const out = new Float64Array(cols * rows * 3);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * img.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.height) / rows));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * img.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.width) / cols));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * img.width + x) * 3;
          r += img.rgb[o]; g += img.rgb[o + 1]; b += img.rgb[o + 2]; n++;
        }
      }
      const o = (cy * cols + cx) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

function signatureOf(img: Image): Signature {
  const g9 = gridMeans(img, 9, 8);
  const grey = (cx: number, cy: number) => { const o = (cy * 9 + cx) * 3; return 0.299 * g9[o] + 0.587 * g9[o + 1] + 0.114 * g9[o + 2]; };
  const hash = new Uint8Array(64);
  const hashMirror = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash[y * 8 + x] = grey(x, y) < grey(x + 1, y) ? 1 : 0;
      hashMirror[y * 8 + x] = grey(8 - x, y) < grey(7 - x, y) ? 1 : 0; // the same hash of the flipped image
    }
  }
  return { hash, hashMirror, color: gridMeans(img, 8, 8) };
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function baselineScore(a: Signature, b: Signature): number {
  const h = Math.min(hamming(a.hash, b.hash), hamming(a.hash, b.hashMirror));
  const hashSim = 1 - h / 64;
  let diff = 0;
  for (let i = 0; i < a.color.length; i++) diff += Math.abs(a.color[i] - b.color[i]);
  const colorSim = 1 - diff / a.color.length / 255;
  return 0.7 * hashSim + 0.3 * colorSim;
}

type Scores = Map<string, Map<string, number>>; // a → b → score

async function detectLocal(clips: ManifestClip[], outDir: string): Promise<Scores> {
  const sigs = new Map<string, Signature>();
  for (const clip of clips) {
    const poster = path.join(outDir, clip.file.replace(/\.mp4$/, '.png'));
    sigs.set(clip.clip_id, signatureOf(decodePng(await fsp.readFile(poster))));
  }
  const scores: Scores = new Map();
  for (const a of clips) {
    const row = new Map<string, number>();
    for (const b of clips) if (a !== b) row.set(b.clip_id, baselineScore(sigs.get(a.clip_id)!, sigs.get(b.clip_id)!));
    scores.set(a.clip_id, row);
  }
  return scores;
}

// ── Memories.ai detector ──────────────────────────────────────────────────

async function createCollection(env: Env, name: string): Promise<string> {
  const base = (env.MEMORIES_BASE?.trim() || DEFAULT_MEMORIES_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/collections`, {
    method: 'POST',
    headers: { Authorization: env.MEMORIES_API_KEY?.trim() ?? '', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name, description: 'ClaimSight Synthetic Evidence Lab (blender/synth_evidence.py clips)' }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /collections → ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  const nested = data.collection && typeof data.collection === 'object' ? data.collection as Record<string, unknown> : {};
  const id = [data.collection_id, data.id, nested.collection_id, nested.id].find(v => typeof v === 'string' && v);
  if (!id) throw new Error(`POST /collections returned no id: ${text.slice(0, 300)}`);
  return id as string;
}

async function detectMemories(clips: ManifestClip[], outDir: string, env: Env): Promise<{ scores: Scores; collection_id: string }> {
  const memories = createMemoriesClient(env);
  let collection = env.MEMORIES_LAB_COLLECTION?.trim() || '';
  if (!collection) {
    collection = await createCollection(env, 'claimsight-lab');
    console.log(`[lab] created Memories.ai collection ${collection} ("claimsight-lab") — export MEMORIES_LAB_COLLECTION=${collection} to reuse it`);
  } else {
    console.log(`[lab] using Memories.ai collection ${collection}`);
  }
  const videoOf = new Map<string, string>();
  const clipOf = new Map<string, string>();
  const ops: Array<{ clip: ManifestClip; operation: string }> = [];
  for (const clip of clips) {
    const bytes = await fsp.readFile(path.join(outDir, clip.file));
    const up = await memories.uploadVideo({ file: new Blob([bytes], { type: 'video/mp4' }), filename: clip.file, orderId: clip.clip_id, collectionId: collection });
    videoOf.set(clip.clip_id, up.video_id);
    clipOf.set(up.video_id, clip.clip_id);
    ops.push({ clip, operation: up.operation });
    console.log(`  upload ${clip.clip_id} → ${up.video_id} (${up.operation})`);
  }
  const deadline = Date.now() + Number(env.LAB_INDEX_TIMEOUT_MS ?? 15 * 60_000);
  for (const { clip, operation } of ops) {
    for (;;) {
      const op = await memories.getOperation(operation);
      if (op.error) throw new Error(`indexing ${clip.clip_id} failed: ${op.error.code} ${op.error.message}`);
      if (op.done) { console.log(`  indexed ${clip.clip_id}`); break; }
      if (Date.now() > deadline) throw new Error(`indexing ${clip.clip_id} timed out`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const scores: Scores = new Map(clips.map(c => [c.clip_id, new Map<string, number>()]));
  for (const clip of clips) {
    const videoId = videoOf.get(clip.clip_id)!;
    const moment = await memories.getMoment(videoId, 0, 2, ['frame']);
    const frame = moment.frames[0]?.url;
    if (!frame) { console.log(`  ${clip.clip_id}: no frame returned, skipping search`); continue; }
    const hits = await memories.searchByImage({ collectionId: collection, imageUrl: frame, topK: 10 });
    const row = scores.get(clip.clip_id)!;
    for (const hit of hits) {
      const other = clipOf.get(hit.video_id);
      if (!other || other === clip.clip_id) continue;
      row.set(other, Math.max(row.get(other) ?? 0, hit.score));
    }
    console.log(`  search ${clip.clip_id}: ${hits.length} hits, best other ${[...row.entries()].sort((a, b) => b[1] - a[1])[0]?.join('=') ?? '-'}`);
  }
  return { scores, collection_id: collection };
}

// ── Metrics ───────────────────────────────────────────────────────────────

interface CurvePoint { threshold: number; recall: number; fpr: number; precision: number; f1: number; mirrored_recall: number | null; tp: number; fp: number; fn: number; tn: number }

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

function sweep(clips: ManifestClip[], scores: Scores): CurvePoint[] {
  const pairs: Array<{ positive: boolean; mirrored: boolean; score: number }> = [];
  const byId = new Map(clips.map(c => [c.clip_id, c]));
  for (const a of clips) {
    for (const b of clips) {
      if (a === b) continue;
      pairs.push({
        positive: a.group_id === b.group_id,
        mirrored: !!(a.variant?.mirrored || byId.get(b.clip_id)?.variant?.mirrored),
        score: scores.get(a.clip_id)?.get(b.clip_id) ?? 0,
      });
    }
  }
  const curve: CurvePoint[] = [];
  for (let i = 50; i <= 98; i += 2) {
    const t = i / 100;
    let tp = 0; let fp = 0; let fn = 0; let tn = 0; let mtp = 0; let mpos = 0;
    for (const p of pairs) {
      const detected = p.score >= t;
      if (p.positive) { if (detected) tp++; else fn++; if (p.mirrored) { mpos++; if (detected) mtp++; } }
      else if (detected) fp++; else tn++;
    }
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const fpr = fp + tn ? fp / (fp + tn) : 0;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    curve.push({ threshold: t, recall: r4(recall), fpr: r4(fpr), precision: r4(precision), f1: r4(f1), mirrored_recall: mpos ? r4(mtp / mpos) : null, tp, fp, fn, tn });
  }
  return curve;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, opts.out);
  const manifestPath = path.join(outDir, 'manifest.json');
  const env = process.env as Env;

  let renderSeconds = 0;
  if (opts.reuse && fs.existsSync(manifestPath)) {
    console.log(`[lab] --reuse: using ${manifestPath}`);
    try {
      const prev = JSON.parse(await fsp.readFile(path.join(PUBLIC_LAB, 'results.json'), 'utf8')) as { summary?: { render_seconds?: number } };
      renderSeconds = Number(prev.summary?.render_seconds) || 0;
    } catch { /* first run */ }
  } else {
    await fsp.mkdir(outDir, { recursive: true });
    renderSeconds = await renderClips(opts, outDir);
    console.log(`[lab] rendered in ${renderSeconds.toFixed(0)}s`);
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as Manifest;
  const clips = manifest.clips.filter(c => {
    const ok = fs.existsSync(path.join(outDir, c.file)) && fs.existsSync(path.join(outDir, c.file.replace(/\.mp4$/, '.png')));
    if (!ok) console.log(`[lab] WARNING ${c.clip_id} has no clip/poster on disk — skipped`);
    return ok;
  });
  if (clips.length < 2) throw new Error('need at least two rendered clips');

  const live = !!env.MEMORIES_API_KEY?.trim() && !isMemoriesStubbed(env);
  const detector: 'memories.ai' | 'local-baseline' = live ? 'memories.ai' : 'local-baseline';
  console.log(`[lab] detector: ${detector}${live ? '' : ' (set MEMORIES_API_KEY and unset MEMORIES_STUB for Memories.ai)'}`);
  const t0 = Date.now();
  let scores: Scores;
  let collectionId: string | undefined;
  if (live) {
    const res = await detectMemories(clips, outDir, env);
    scores = res.scores; collectionId = res.collection_id;
  } else {
    scores = await detectLocal(clips, outDir);
  }
  const detectSeconds = (Date.now() - t0) / 1000;

  const curve = sweep(clips, scores);
  let best = curve[0];
  for (const pt of curve) if (pt.f1 >= best.f1) best = pt; // ties → the higher threshold
  const recommended = best.threshold;

  // Twin pairs (unordered, ground truth) with their best-direction score — what eval/lab_eval.py grades.
  const byId = new Map(clips.map(c => [c.clip_id, c]));
  const twinPairs = clips.filter(c => c.twin_of && byId.has(c.twin_of)).map(b => {
    const a = byId.get(b.twin_of!)!;
    const score = Math.max(scores.get(a.clip_id)?.get(b.clip_id) ?? 0, scores.get(b.clip_id)?.get(a.clip_id) ?? 0);
    return { a: a.clip_id, b: b.clip_id, group_id: b.group_id, product: b.product, damage_type: b.damage_type, mirrored: !!b.variant?.mirrored, score: r4(score), detected: score >= recommended };
  });

  await fsp.mkdir(path.join(PUBLIC_LAB, 'clips'), { recursive: true });
  for (const clip of clips) {
    await fsp.copyFile(path.join(outDir, clip.file.replace(/\.mp4$/, '.png')), path.join(PUBLIC_LAB, 'clips', `${clip.clip_id}.png`));
    await fsp.copyFile(path.join(outDir, clip.file), path.join(PUBLIC_LAB, 'clips', `${clip.clip_id}.mp4`));
  }
  const results = {
    generated_at: new Date().toISOString(),
    detector,
    ...(collectionId ? { collection_id: collectionId } : {}),
    options: { ...opts, out: path.relative(ROOT, outDir), render: manifest.options, seed: manifest.seed },
    clips: clips.map(c => ({
      clip_id: c.clip_id, product: c.product, damaged: c.damaged, damage_type: c.damage_type, damage_location: c.damage_location,
      group_id: c.group_id, twin_of: c.twin_of, mirrored: !!c.variant?.mirrored,
      poster: `/lab/clips/${c.clip_id}.png`, video: `/lab/clips/${c.clip_id}.mp4`,
      top_matches: [...(scores.get(c.clip_id) ?? new Map<string, number>()).entries()]
        .sort((x, y) => y[1] - x[1]).slice(0, TOP_MATCHES).map(([clip_id, score]) => ({ clip_id, score: r4(score) })),
    })),
    curve: curve.map(({ threshold, recall, fpr, precision, f1, mirrored_recall }) => ({ threshold, recall, fpr, precision, f1, mirrored_recall })),
    recommended_threshold: recommended,
    twin_pairs: twinPairs,
    summary: {
      clips: clips.length,
      twin_pairs: twinPairs.length,
      recall: best.recall,
      fpr: best.fpr,
      precision: best.precision,
      f1: best.f1,
      mirrored_recall: best.mirrored_recall,
      mirrored_pairs: twinPairs.filter(p => p.mirrored).length,
      render_seconds: Math.round(renderSeconds),
      detect_seconds: Math.round(detectSeconds * 10) / 10,
      detector,
    },
  };
  const resultsPath = path.join(PUBLIC_LAB, 'results.json');
  await fsp.writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  // Summary table
  const pad = (v: string | number, w: number) => String(v).padStart(w);
  console.log('');
  console.log(`ClaimSight Synthetic Evidence Lab · detector=${detector} · ${clips.length} clips · ${twinPairs.length} twin pairs (${results.summary.mirrored_pairs} mirrored) · render ${Math.round(renderSeconds)}s · detect ${results.summary.detect_seconds}s`);
  console.log(`${pad('threshold', 10)} ${pad('recall', 7)} ${pad('fpr', 7)} ${pad('precision', 10)} ${pad('f1', 6)} ${pad('mirrored', 9)}`);
  for (const pt of curve) {
    const mark = pt.threshold === recommended ? '  ◀ recommended' : '';
    console.log(`${pad(pt.threshold.toFixed(2), 10)} ${pad(pt.recall.toFixed(3), 7)} ${pad(pt.fpr.toFixed(3), 7)} ${pad(pt.precision.toFixed(3), 10)} ${pad(pt.f1.toFixed(3), 6)} ${pad(pt.mirrored_recall === null ? '-' : pt.mirrored_recall.toFixed(3), 9)}${mark}`);
  }
  console.log('');
  console.log(`twin pairs at ${recommended.toFixed(2)}:`);
  for (const p of twinPairs) console.log(`  ${p.a} ↔ ${p.b}  ${p.product.padEnd(10)} ${String(p.damage_type ?? '-').padEnd(8)} ${p.mirrored ? 'mirrored ' : '         '} score ${p.score.toFixed(3)}  ${p.detected ? 'detected' : 'MISSED'}`);
  console.log(`recommended_threshold=${recommended.toFixed(2)} recall=${best.recall} fpr=${best.fpr} precision=${best.precision} f1=${best.f1} mirrored_recall=${best.mirrored_recall ?? '-'}`);
  console.log(`wrote ${path.relative(ROOT, resultsPath)} + ${clips.length} posters under public/lab/clips/`);
}

main().catch(e => {
  console.error(`[lab] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
