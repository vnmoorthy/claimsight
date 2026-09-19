/**
 * Index the demo evidence clips into Memories.ai and wire their video ids into data/demo_evidence.json.
 *
 *   MEMORIES_API_KEY=sk-mai-… npx tsx scripts/index-demo-clips.ts [--collection col_…] [--clip A1042=path.mp4 …] [--write]
 *
 * - Creates a `claimsight-claims` collection when --collection / MEMORIES_CLAIMS_COLLECTION is not set.
 * - Uploads each clip (defaults: the synthetic clips in assets/test-clips), waits for indexing
 *   (preprocess → index → derive), prints the summary and first captions.
 * - Runs the fraud-twin image search between the A1043 clip and the rest so you can tune
 *   FRAUD_SIMILARITY_THRESHOLD before the demo.
 * - With --write, rewrites data/demo_evidence.json with the real video ids.
 *
 * Run this at 10:45 with the real phone clips so indexing finishes while you build.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoriesClient, DEFAULT_MEMORIES_BASE } from '../cloud-functions/_memories';
import { resolveEnv } from '../cloud-functions/_kv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = resolveEnv();
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const write = args.includes('--write');

const DEFAULT_CLIPS: Array<{ order_id: string; label: string; file: string }> = [
  { order_id: 'A1042', label: 'Chipped mug — A1042 (clean auto-approve)', file: 'assets/test-clips/mug_chipped.mp4' },
  { order_id: 'A1043', label: 'Same mug footage, other account — A1043 (fraud twin)', file: 'assets/test-clips/mug_chipped_twin.mp4' },
  { order_id: 'A1050', label: 'Scuffed headphones — A1050 (above $75 limit)', file: 'assets/test-clips/headphones_scuffed.mp4' },
  { order_id: 'A1046', label: 'Mug, no damage — A1046 (evidence review)', file: 'assets/test-clips/mug_intact.mp4' },
];

async function main(): Promise<void> {
  const key = env.MEMORIES_API_KEY?.trim();
  if (!key) {
    console.error('MEMORIES_API_KEY is not set. Get one at https://memories.ai/app and re-run.');
    process.exit(2);
  }
  const base = (env.MEMORIES_BASE?.trim() || DEFAULT_MEMORIES_BASE).replace(/\/+$/, '');
  const headers = { Authorization: key, 'Content-Type': 'application/json' };

  // 1. collection
  let collectionId = flag('--collection') ?? env.MEMORIES_CLAIMS_COLLECTION?.trim();
  if (!collectionId) {
    const res = await fetch(`${base}/collections`, { method: 'POST', headers, body: JSON.stringify({ name: `claimsight-claims-${Date.now()}` }) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`create collection failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    collectionId = body.collection_id ?? body.id ?? body.collection?.id;
    console.log(`created collection ${collectionId}`);
  } else {
    console.log(`using collection ${collectionId}`);
  }
  if (!collectionId) throw new Error('no collection id');

  // 2. clips
  const overrides = args.flatMap((a, i) => (a === '--clip' && args[i + 1] ? [args[i + 1]] : []))
    .map(s => { const [order_id, file] = s.split('='); return { order_id, file }; });
  const clips = DEFAULT_CLIPS.map(c => ({ ...c, file: overrides.find(o => o.order_id === c.order_id)?.file ?? c.file }));
  for (const o of overrides) if (!clips.some(c => c.order_id === o.order_id)) clips.push({ order_id: o.order_id, label: `Evidence — ${o.order_id}`, file: o.file });

  const client = createMemoriesClient({ ...env, MEMORIES_API_KEY: key, MEMORIES_STUB: '0', MEMORIES_CLAIMS_COLLECTION: collectionId });
  const results: Array<{ order_id: string; label: string; video_id: string; summary?: string; caption?: string }> = [];

  for (const c of clips) {
    const abs = path.isAbsolute(c.file) ? c.file : path.join(ROOT, c.file);
    const bytes = await fs.readFile(abs);
    const up = await client.uploadVideo({ file: new Blob([bytes], { type: 'video/mp4' }), filename: path.basename(abs), orderId: c.order_id, collectionId, fps: 1 });
    process.stdout.write(`${c.order_id} ← ${path.basename(abs)} → ${up.video_id} (op ${up.operation}) indexing`);
    const started = Date.now();
    for (;;) {
      const op = await client.getOperation(up.operation);
      if (op.error) throw new Error(`indexing failed for ${up.video_id}: ${op.error.code} ${op.error.message}`);
      if (op.done) break;
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 4000));
      if (Date.now() - started > 15 * 60_000) throw new Error('indexing took longer than 15 minutes');
    }
    const summary = await client.getSummary(up.video_id).catch(() => '');
    const caption = await client.getCaption(up.video_id).catch(() => ({ text: '', segments: [] as Array<{ start: number; end: number; text: string }> }));
    console.log(` done in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(`   summary: ${summary.slice(0, 160)}`);
    console.log(`   caption: ${caption.segments.slice(0, 2).map(s => `[${s.start}-${s.end}] ${s.text}`).join(' | ').slice(0, 200)}`);
    results.push({ order_id: c.order_id, label: c.label, video_id: up.video_id, summary, caption: caption.text });
  }

  // 3. fraud-twin similarity report
  const twin = results.find(r => r.order_id === 'A1043');
  if (twin) {
    try {
      const moment = await client.getMoment(twin.video_id, 0, 5, ['frame']);
      const frame = moment.frames[0]?.url;
      if (frame) {
        const hits = await client.searchByImage({ collectionId, imageUrl: frame, topK: 10 });
        console.log('\nfraud-twin image search from A1043 frame:');
        for (const h of hits) {
          const who = results.find(r => r.video_id === h.video_id)?.order_id ?? '?';
          console.log(`   ${h.video_id} (${who})  score ${h.score.toFixed(3)}${h.video_id === twin.video_id ? '  (self)' : ''}`);
        }
        const best = hits.filter(h => h.video_id !== twin.video_id).sort((a, b) => b.score - a.score)[0];
        if (best) console.log(`   → set FRAUD_SIMILARITY_THRESHOLD just below ${best.score.toFixed(2)} (current ${env.FRAUD_SIMILARITY_THRESHOLD ?? '0.80'})`);
      }
    } catch (e) {
      console.log(`fraud-twin search skipped: ${(e as Error).message}`);
    }
  }

  // 4. write demo_evidence.json
  if (write) {
    const file = path.join(ROOT, 'data', 'demo_evidence.json');
    const current: any = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{"items":[]}'));
    const items = Array.isArray(current) ? current : current.items ?? [];
    const merged = results.map(r => ({ label: r.label, video_id: r.video_id, order_id: r.order_id }))
      .concat(items.filter((i: any) => !results.some(r => r.order_id === i.order_id)));
    await fs.writeFile(file, JSON.stringify(Array.isArray(current) ? merged : { ...current, items: merged }, null, 2) + '\n');
    console.log(`\nwrote ${path.relative(ROOT, file)} with ${results.length} real video ids`);
  }
  console.log(`\nadd to .env:\n  MEMORIES_API_KEY=${key.slice(0, 8)}…\n  MEMORIES_CLAIMS_COLLECTION=${collectionId}\n  MEMORIES_STUB=0`);
}

main().catch(e => { console.error(e); process.exit(1); });
