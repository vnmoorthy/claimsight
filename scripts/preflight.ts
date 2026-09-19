/**
 * Stage preflight: checks every credential and service ClaimSight depends on, in one command.
 *
 *   npx tsx scripts/preflight.ts            # reads .env via dotenv + process.env
 *
 * Exit code 0 when everything required for the chosen mode is green. Nothing here mutates data
 * (Memories.ai list calls are free; the gateway check lists models; the backend check hits /stats).
 */
import 'dotenv/config';

type Check = { name: string; ok: boolean; detail: string; required: boolean };
const env = process.env as Record<string, string | undefined>;
const checks: Check[] = [];
const push = (name: string, ok: boolean, detail: string, required = true) => checks.push({ name, ok, detail, required });
const withTimeout = async <T>(p: Promise<T>, ms = 12000): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (t) clearTimeout(t); }
};

async function main(): Promise<void> {
  const backend = env.PREFLIGHT_BACKEND ?? env.SELF_BASE_URL ?? 'http://localhost:8088';

  // 1. Backend
  try {
    const r = await withTimeout(fetch(`${backend}/stats`));
    const j: any = await r.json();
    push('Backend', r.ok, `${backend} · ${j.backend_label ?? j.backend ?? '?'} · mode ${j.mode_label ?? '?'}` + (j.llm ? ` · llm ${j.llm.configured ? 'configured' : 'not configured'}` : ''));
  } catch (e) { push('Backend', false, `${backend} unreachable: ${(e as Error).message}`); }

  // 2. AI Gateway / LLM
  const gwKey = env.AI_GATEWAY_API_KEY?.trim();
  const gwBase = (env.AI_GATEWAY_BASE_URL?.trim() || 'https://ai-gateway.edgeone.link/v1').replace(/\/+$/, '');
  const model = env.AI_GATEWAY_MODEL?.trim() || '@makers/deepseek-v4-pro';
  if (!gwKey && !env.ANTHROPIC_API_KEY) {
    push('AI model', false, 'no AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY → agent runs the policy engine (fine for the demo, no LLM narration)', false);
  } else if (gwKey) {
    try {
      const r = await withTimeout(fetch(`${gwBase}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${gwKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 5 }),
      }), 25000);
      const j: any = await r.json().catch(() => ({}));
      const text = j?.choices?.[0]?.message?.content ?? '';
      push('AI model', r.ok, `${gwBase} · ${model} · HTTP ${r.status}${text ? ` · "${String(text).trim().slice(0, 20)}"` : ''}${j?.error ? ` · ${JSON.stringify(j.error).slice(0, 120)}` : ''}`);
    } catch (e) { push('AI model', false, `${gwBase}: ${(e as Error).message}`); }
  } else {
    push('AI model', true, 'ANTHROPIC_API_KEY set (direct Anthropic)');
  }

  // 3. Memories.ai
  const mKey = env.MEMORIES_API_KEY?.trim();
  const mBase = (env.MEMORIES_BASE?.trim() || 'https://api.memories.ai/serve/datalake/v1').replace(/\/+$/, '');
  const stubbed = env.MEMORIES_STUB === '1' || env.MEMORIES_STUB === 'true' || !mKey;
  if (stubbed) {
    push('Memories.ai', !!mKey === false, mKey ? 'MEMORIES_STUB=1 with a key set: stubbed responses will be used' : 'no key → canned evidence (demo mode)', false);
  } else {
    try {
      const r = await withTimeout(fetch(`${mBase}/collections`, { headers: { Authorization: mKey! } }));
      const j: any = await r.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.collections ?? j.items ?? j.data ?? []);
      const col = env.MEMORIES_CLAIMS_COLLECTION?.trim();
      const hasCol = !col || list.some((c: any) => (c.collection_id ?? c.id) === col);
      push('Memories.ai', r.ok && hasCol, `${mBase} · HTTP ${r.status} · ${list.length} collections${col ? ` · claims collection ${hasCol ? 'found' : 'NOT FOUND'} (${col})` : ' · MEMORIES_CLAIMS_COLLECTION not set'}`);
      if (r.ok) {
        try {
          const b = await withTimeout(fetch(`${mBase}/operations/balance`, { headers: { Authorization: mKey! } }));
          if (b.ok) { const bj: any = await b.json().catch(() => ({})); push('Memories.ai balance', true, JSON.stringify(bj).slice(0, 100), false); }
        } catch { /* optional */ }
      }
    } catch (e) { push('Memories.ai', false, `${mBase}: ${(e as Error).message}`); }
  }

  // 4. Demo evidence ids resolve (real mode only)
  if (!stubbed) {
    try {
      const fs = await import('node:fs/promises');
      const raw = JSON.parse(await fs.readFile(new URL('../data/demo_evidence.json', import.meta.url), 'utf8'));
      const items: any[] = Array.isArray(raw) ? raw : raw.items ?? [];
      const stubIds = items.filter(i => String(i.video_id).startsWith('vid_stub_'));
      push('Demo clips indexed', stubIds.length === 0, stubIds.length ? `${stubIds.length} demo clips still point at stub ids → run: npm run index:clips -- --write` : `${items.length} demo clips with real video ids`);
    } catch (e) { push('Demo clips indexed', false, (e as Error).message); }
  }

  // 5. AgentX
  const ax = (env.AGENTX_OTLP_URL?.trim() || 'http://localhost:4700/api/v1/otel/v1/traces').replace(/\/api\/v1\/otel\/v1\/traces$/, '');
  try {
    const r = await withTimeout(fetch(`${ax}/health`));
    push('AgentX', r.ok, `${ax} · HTTP ${r.status} · key ${env.AGENTX_API_KEY ? 'set' : 'NOT set (traces skipped)'}`, false);
  } catch (e) { push('AgentX', false, `${ax}: ${(e as Error).message}`, false); }

  // 6. Slack
  push('Slack webhook', !!env.SLACK_WEBHOOK_URL, env.SLACK_WEBHOOK_URL ? 'configured (not sent)' : 'not configured → escalations show only in the desk', false);

  // 7. S3 archive
  if (env.AWS_S3_BUCKET) {
    try {
      const { archiveHealth } = await import('../cloud-functions/_archive');
      const h = await withTimeout(archiveHealth(env));
      push('S3 archive', !!h.reachable, `${h.bucket} · ${h.reachable ? 'reachable' : h.error}`, false);
    } catch (e) { push('S3 archive', false, (e as Error).message, false); }
  } else push('S3 archive', true, 'off (AWS_S3_BUCKET not set)', false);

  // report
  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  console.log('\nClaimSight preflight\n');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : c.required ? 'FAIL' : 'WARN'}  ${pad(c.name, 22)} ${c.detail}`);
  const failed = checks.filter(c => !c.ok && c.required);
  console.log(failed.length ? `\n${failed.length} required check(s) failed.` : '\nAll required checks passed.');
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
