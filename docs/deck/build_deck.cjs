// ClaimSight — 10-slide pitch deck generator (pptxgenjs).
// Usage: NODE_PATH=$(npm root -g) node docs/deck/build_deck.cjs   (run from the claimsight/ folder)
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

const ROOT = path.resolve(__dirname, '..', '..');
const A = (f) => path.join(ROOT, 'assets', f);
const S = (f) => path.join(ROOT, 'public', 'screenshots', f);
const has = (p) => fs.existsSync(p);

const C = {
  ground: '0F1320', surface: '171C2B', surface2: '1F2536', line: '2A3145', lineStrong: '3B4460',
  ink: 'E8ECF6', ink2: 'B3BBD1', muted: '7F89A6', accent: '3987E5', accentSoft: '1C2C48', aqua: '2BC0A0',
  lGround: 'F4F6FA', lSurface: 'FFFFFF', lSurface2: 'EEF1F7', lInk: '151A2B', lInk2: '4A5270', lMuted: '7F88A4', lLine: 'DBE0EC', lAccent: '2A78D6', lAqua: '1BAF7A',
  good: '3CCC6A', goodSoft: '15301F', crit: 'FF6B6B', critSoft: '3A1B1B', lCrit: 'CF3434', lCritSoft: 'FBE5E5',
};
const F = { display: 'Arial', body: 'Arial', mono: 'Courier New' };

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
pres.author = 'ClaimSight'; pres.title = 'ClaimSight — Refunds with receipts';

const W = 13.333, H = 7.5, M = 0.6;

function base(dark) {
  const s = pres.addSlide();
  s.background = { color: dark ? C.ground : C.lGround };
  return s;
}
function text(s, t, o) {
  s.addText(t, Object.assign({ isTextBox: true, margin: 0, fontFace: F.body, valign: 'top' }, o));
}
function eyebrow(s, t, dark, y = 0.55) {
  text(s, t.toUpperCase(), { x: M, y, w: W - 2 * M, h: 0.3, fontFace: F.mono, fontSize: 11, charSpacing: 3, color: dark ? C.muted : C.lMuted });
}
function title(s, t, dark, o = {}) {
  text(s, t, Object.assign({ x: M, y: 0.9, w: W - 2 * M, h: 1.0, fontFace: F.display, fontSize: 34, bold: true, color: dark ? C.ink : C.lInk, valign: 'middle' }, o));
}
function card(s, x, y, w, h, dark, o = {}) {
  s.addShape(pres.ShapeType.roundRect, Object.assign({ x, y, w, h, rectRadius: 0.12, fill: { color: dark ? C.surface : C.lSurface }, line: { color: dark ? C.line : C.lLine, width: 1 } }, o));
}
function footer(s, n, dark) {
  text(s, 'ClaimSight · The Executable World · Sept 19, 2026', { x: M, y: H - 0.55, w: 8, h: 0.3, fontFace: F.mono, fontSize: 10, color: dark ? C.muted : C.lMuted });
  text(s, String(n), { x: W - M - 1, y: H - 0.55, w: 1, h: 0.3, fontFace: F.mono, fontSize: 10, color: dark ? C.muted : C.lMuted, align: 'right' });
}
function numberBadge(s, n, x, y, dark) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: 0.42, h: 0.42, fill: { color: dark ? C.accentSoft : 'E4EEFB' }, line: { color: dark ? C.accent : C.lAccent, width: 1 } });
  text(s, String(n), { x, y, w: 0.42, h: 0.42, fontFace: F.mono, fontSize: 13, bold: true, color: dark ? C.accent : C.lAccent, align: 'center', valign: 'middle' });
}
function imageFit(s, p, x, y, w, h) {
  s.addImage({ path: p, x, y, w, h, sizing: { type: 'contain', w, h } });
}

// ---------- 1. Cover ----------
{
  const s = base(true);
  eyebrow(s, 'The Executable World · Sept 19 2026 · Track 1 · AI Assistants', true, 0.9);
  text(s, 'ClaimSight', { x: M, y: 1.4, w: 7.4, h: 1.5, fontFace: F.display, fontSize: 80, bold: true, color: C.ink });
  text(s, 'Refunds with receipts.', { x: M, y: 2.95, w: 7.4, h: 0.9, fontFace: F.display, fontSize: 40, bold: true, color: C.aqua });
  text(s, 'An after-sales teammate that watches the customer’s evidence video, applies your refund policy, executes the refund itself, and catches returns fraud by matching footage across accounts.', { x: M, y: 4.1, w: 6.6, h: 1.5, fontSize: 17, color: C.ink2, lineSpacingMultiple: 1.25 });
  text(s, 'Team [name] · github.com/vnmoorthy/claimsight', { x: M, y: 6.6, w: 7, h: 0.3, fontFace: F.mono, fontSize: 11, color: C.muted });
  imageFit(s, A('card.png'), 7.7, 1.45, 5.0, 5.15);
  s.addNotes('Twenty seconds. Say the tagline, then go straight to the problem.');
}

// ---------- 2. Problem ----------
{
  const s = base(false);
  eyebrow(s, 'The problem', false);
  title(s, 'Every refund still needs a human to squint at a photo.', false);
  const y = 2.3, h = 3.9, w = (W - 2 * M - 0.8) / 3;
  const cols = [
    { big: '$101B', head: 'lost to return fraud', body: 'US retailers, 2023. $13.70 of every $100 returned is fraud or abuse. (NRF and Appriss Retail, 2023 Consumer Returns in the Retail Industry)' },
    { big: '0', head: 'people watching the evidence', body: 'Customers send photos and videos. Agents skim them, guess, and either overpay or escalate everything to a queue.' },
    { big: '3', head: 'claims, one cracked mug', body: 'The same damaged item gets filmed for three claims from three "customers". No refund queue can see across accounts.' },
  ];
  cols.forEach((c, i) => {
    const x = M + i * (w + 0.4);
    card(s, x, y, w, h, false);
    text(s, c.big, { x: x + 0.35, y: y + 0.35, w: w - 0.7, h: 1.2, fontFace: F.display, fontSize: 60, bold: true, color: C.lAccent });
    text(s, c.head, { x: x + 0.35, y: y + 1.65, w: w - 0.7, h: 0.6, fontSize: 18, bold: true, color: C.lInk });
    text(s, c.body, { x: x + 0.35, y: y + 2.3, w: w - 0.7, h: 1.4, fontSize: 13, color: C.lInk2, lineSpacingMultiple: 1.2 });
  });
  footer(s, 2, false);
  s.addNotes('Fifteen seconds. The $101B figure is from the NRF / Appriss Retail 2023 returns report: $743B returned, 14.5% of sales, fraud and abuse about 14% of returns.');
}

// ---------- 3. What it is ----------
{
  const s = base(false);
  eyebrow(s, 'What ClaimSight is', false);
  title(s, 'An after-sales teammate that finishes the job.', false);
  const rows = [
    ['Sees the evidence', 'Memories.ai indexes the customer’s 10-second clip: "white ceramic mug, chip on the rim at 0:03". Captions, frames and a summary become the claim’s evidence record.'],
    ['Applies your policy', 'Orders and policy clauses P1–P6 live as structured JSON in Makers storage. No vector database. Every decision cites the clauses it used.'],
    ['Executes the transaction', 'Refund or replacement is written to the ledger by a cloud function that re-checks the limits itself. Humans are pulled in only above $75 or on a fraud signal. The receipt is a Blender-rendered 3D twin of the damage.'],
  ];
  rows.forEach((r, i) => {
    const y = 2.35 + i * 1.45;
    numberBadge(s, i + 1, M, y + 0.05, false);
    text(s, r[0], { x: M + 0.65, y, w: 6.2, h: 0.4, fontSize: 19, bold: true, color: C.lInk });
    text(s, r[1], { x: M + 0.65, y: y + 0.45, w: 6.2, h: 0.95, fontSize: 13, color: C.lInk2, lineSpacingMultiple: 1.2 });
  });
  imageFit(s, has(A('twin/sample-mug.png')) ? A('twin/sample-mug.png') : A('card.png'), 7.3, 2.35, 5.4, 3.9);
  text(s, 'Damage Twin receipt: rendered in Blender where Memories.ai saw the damage', { x: 7.3, y: 6.3, w: 5.4, h: 0.3, fontSize: 10, color: C.lMuted });
  footer(s, 3, false);
  s.addNotes('Three promises: it sees, it applies policy, it executes. The card on the right is what the customer and the manager both see.');
}

// ---------- 4. The loop ----------
{
  const s = base(true);
  eyebrow(s, 'The event thesis, executed', true);
  title(s, 'One loop, from evidence to ledger entry.', true);
  const steps = [
    ['Data', 'Video + order', 'A 10-second clip. Orders and policy as JSON in Makers storage.'],
    ['Intelligence', 'See the damage', 'Memories.ai captions the clip and image-searches every prior claim for a twin.'],
    ['Experience', 'Decision Card', 'Streaming chat shows the reasoning, cited clauses, evidence line and txn id.'],
    ['Execution', 'Policy, twice', 'The agent applies it; the refund service enforces it again. Over limit? A human in Slack.'],
    ['Transaction', 'Refund issued', 'Ledger entry, decision record, AgentX trace, dashboard row.'],
  ];
  const w = (W - 2 * M - 4 * 0.25) / 5, y = 2.3, h = 3.5;
  steps.forEach((st, i) => {
    const x = M + i * (w + 0.25), last = i === 4;
    card(s, x, y, w, h, true, last ? { fill: { color: '16324A' }, line: { color: C.aqua, width: 1.25 } } : {});
    text(s, st[0].toUpperCase(), { x: x + 0.25, y: y + 0.3, w: w - 0.5, h: 0.3, fontFace: F.mono, fontSize: 10, charSpacing: 2, color: last ? C.aqua : C.accent });
    text(s, st[1], { x: x + 0.25, y: y + 0.7, w: w - 0.5, h: 0.7, fontSize: 18, bold: true, color: C.ink });
    text(s, st[2], { x: x + 0.25, y: y + 1.5, w: w - 0.5, h: 1.8, fontSize: 12.5, color: C.ink2, lineSpacingMultiple: 1.2 });
  });
  text(s, 'Most teams stop at a chat answer. ClaimSight reaches the last layer: a transaction with a receipt.', { x: M, y: 6.15, w: W - 2 * M, h: 0.5, fontSize: 15, color: C.ink2 });
  footer(s, 4, true);
  s.addNotes('Walk the five cards left to right in twenty seconds. Land on Transaction: this is the layer most teams never reach.');
}

// ---------- 5. Live demo ----------
{
  const s = base(false);
  eyebrow(s, 'Live demo', false);
  title(s, 'A chipped mug. A refund. A fraud catch.', false);
  const beats = [
    ['0:00', 'Claim', '"My mug arrived chipped, order A1042." Evidence clip attached. The trace lights up: order, policy, evidence, fraud, execute, record.'],
    ['0:30', 'Decision', 'Damage seen at 0:02. Window checked (P1), damage visible (P2), replacement-first rule applied (P4). $24 is under the $75 limit: refund executed, transaction id on the card, and a 3D Damage Twin renders into the card 25 s later.'],
    ['1:00', 'Twin', 'Same footage from a different account. Image search finds it at 0.93 similarity. Claim frozen, escalated to Slack, denied by the manager in the Refund Desk.'],
  ];
  beats.forEach((b, i) => {
    const y = 2.3 + i * 1.4;
    card(s, M, y, 5.9, 1.2, false);
    text(s, b[0], { x: M + 0.25, y: y + 0.2, w: 0.8, h: 0.3, fontFace: F.mono, fontSize: 12, bold: true, color: C.lAccent });
    text(s, b[1], { x: M + 1.05, y: y + 0.17, w: 4.6, h: 0.35, fontSize: 16, bold: true, color: C.lInk });
    text(s, b[2], { x: M + 1.05, y: y + 0.52, w: 4.6, h: 0.65, fontSize: 11.5, color: C.lInk2, lineSpacingMultiple: 1.15 });
  });
  const shot = has(S('chat-twin.png')) ? S('chat-twin.png') : has(S('chat.png')) ? S('chat.png') : A('card.png');
  card(s, 6.9, 2.2, 5.85, 4.55, false, { fill: { color: C.lSurface2 } });
  imageFit(s, shot, 7.0, 2.3, 5.65, 4.35);
  footer(s, 5, false);
  s.addNotes('Switch to the app here. Evidence clips are pre-indexed; filming on stage is theater. If the gateway is slow, the deterministic policy engine takes over automatically and the trace looks identical.');
}

// ---------- 6. Architecture ----------
{
  const s = base(true);
  eyebrow(s, 'How it works', true);
  title(s, 'Agent runtime, cloud functions and storage on EdgeOne Makers; co-hosts do the seeing, gating and reviewing.', true, { fontSize: 24, h: 0.9 });
  const w = 8.2, h = w * 960 / 1600; // 4.92
  imageFit(s, A('architecture.png'), (W - w) / 2, 1.85, w, h);
  footer(s, 6, true);
  s.addNotes('Top: the React app, Slack/WorkBuddy and AgentX. Middle: the agent, cloud functions and Blob storage on Makers. Bottom: Memories.ai, the AI Gateway, VeloDB and AWS. Secrets never leave the functions layer.');
}

// ---------- 7. Fraud twin ----------
{
  const s = base(false);
  eyebrow(s, 'The moment that turns the room', false);
  title(s, 'The same mug, a different account.', false);
  text(s, 'Every evidence clip is indexed into the claims collection. Before paying, ClaimSight takes a frame from the new clip and runs an image search across every prior claim. The detector was crash-tested with a Blender-rendered synthetic evidence set.', { x: M, y: 2.3, w: 5.9, h: 1.2, fontSize: 15, color: C.lInk2, lineSpacingMultiple: 1.25 });
  text(s, '0.93', { x: M, y: 3.45, w: 3, h: 1.2, fontFace: F.display, fontSize: 64, bold: true, color: C.lCrit });
  text(s, 'similarity to the claim on order A1042, filed by another customer', { x: M, y: 4.65, w: 5.9, h: 0.5, fontSize: 14, bold: true, color: C.lInk });
  text(s, [
    { text: 'Policy P5 freezes the claim instead of paying it.', options: { bullet: true, breakLine: true } },
    { text: 'The manager gets a Slack ping through the WorkBuddy Refund Desk skill.', options: { bullet: true, breakLine: true } },
    { text: 'One click in the desk: approve or deny, with a note that lands in the audit record.', options: { bullet: true } },
  ], { x: M, y: 5.25, w: 5.9, h: 1.4, fontSize: 13, color: C.lInk2, paraSpaceAfter: 6 });
  const labPath = path.join(ROOT, 'public', 'lab', 'results.json');
  let lab = null;
  try { lab = JSON.parse(fs.readFileSync(labPath, 'utf8')); } catch (e) { lab = null; }
  const shot = has(S('lab.png')) ? S('lab.png') : has(S('desk.png')) ? S('desk.png') : A('card.png');
  card(s, 6.9, 2.2, 5.85, 3.55, false, { fill: { color: C.lSurface2 } });
  imageFit(s, shot, 7.0, 2.3, 5.65, 3.35);
  const sum = lab && lab.summary ? lab.summary : null;
  const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—');
  const tiles = [
    [sum ? String(sum.clips) : '—', 'synthetic clips rendered in Blender'],
    [sum ? pct(sum.recall) : '—', 'twin recall at the shipped threshold'],
    [sum ? pct(sum.fpr) : '—', 'false-positive rate'],
    [lab && lab.recommended_threshold ? String(lab.recommended_threshold) : '—', 'similarity threshold from data'],
  ];
  const tw = (5.85 - 3 * 0.15) / 4;
  tiles.forEach((t, i) => {
    const x = 6.9 + i * (tw + 0.15), y = 5.9;
    card(s, x, y, tw, 0.95, false);
    text(s, t[0], { x: x + 0.12, y: y + 0.08, w: tw - 0.24, h: 0.45, fontFace: F.display, fontSize: 22, bold: true, color: C.lAccent });
    text(s, t[1], { x: x + 0.12, y: y + 0.52, w: tw - 0.24, h: 0.4, fontSize: 8.5, color: C.lInk2, lineSpacingMultiple: 1.05 });
  });
  text(s, 'Synthetic Evidence Lab · detector: ' + (sum ? sum.detector : 'Memories.ai image search'), { x: 6.9, y: 5.62, w: 5.85, h: 0.25, fontSize: 9, color: C.lMuted });
  footer(s, 7, false);
  s.addNotes('This is the wow beat. Say the number out loud: ninety-three percent similarity, different account, frozen, escalated, denied.');
}

// ---------- 8. Production ready ----------
{
  const s = base(false);
  eyebrow(s, 'Production-ready, not a demo agent', false);
  title(s, 'Shipped like software.', false);
  const tiles = [
    ['30', 'golden claims', 'clean, over-limit, out-of-window, replacement-first, fraud twin, non-returnable'],
    ['7.5', 'gate floor out of 10', 'plus a no-regression check against the previous run; CI fails the build below it'],
    ['3', 'online monitors', 'PII, secrets and prompt-injection scorers on every reply'],
    ['1', 'trace per claim', 'every tool call, latency and decision in AgentX, linked to the eval run'],
  ];
  const w = 2.75, h = 1.75, gx = 0.25, gy = 0.25, y0 = 2.25;
  tiles.forEach((t, i) => {
    const x = M + (i % 2) * (w + gx), y = y0 + Math.floor(i / 2) * (h + gy);
    card(s, x, y, w, h, false);
    text(s, t[0], { x: x + 0.25, y: y + 0.18, w: w - 0.5, h: 0.7, fontFace: F.display, fontSize: 40, bold: true, color: C.lAccent });
    text(s, t[1], { x: x + 0.25, y: y + 0.85, w: w - 0.5, h: 0.3, fontSize: 13, bold: true, color: C.lInk });
    text(s, t[2], { x: x + 0.25, y: y + 1.15, w: w - 0.5, h: 0.55, fontSize: 9.5, color: C.lInk2, lineSpacingMultiple: 1.1 });
  });
  const shotX = M + 2 * w + gx + 0.35, shotW = W - M - shotX;
  const shot = has(A('agentx-traces.png')) ? A('agentx-traces.png') : A('architecture.png');
  card(s, shotX, y0, shotW, 2 * h + gy, false, { fill: { color: C.lSurface2 } });
  imageFit(s, shot, shotX + 0.1, y0 + 0.1, shotW - 0.2, 2 * h + gy - 0.2);
  text(s, 'AgentX Observe: one trace per ClaimSight claim, straight from the running backend.', { x: shotX, y: y0 + 2 * h + gy + 0.05, w: shotW, h: 0.3, fontSize: 10, color: C.lMuted });
  const y2 = 6.35;
  text(s, [
    { text: 'Limits live in the refund service, not the prompt: ', options: { bold: true, color: C.lInk } },
    { text: 'the function re-checks amount, window and approval header, so the model cannot exceed policy even when asked to. The agent has no shell, no browser and no keys. If the gateway blinks, a deterministic policy engine runs the same steps and produces the same card.', options: { color: C.lInk2 } },
  ], { x: M, y: y2, w: W - 2 * M, h: 0.55, fontSize: 12, lineSpacingMultiple: 1.15 });
  footer(s, 8, false);
  s.addNotes('Latest live run of the 30-claim golden set through the HTTP path: mean 10 of 10 with the offline policy scorer, p95 55 ms, gate PASS. Show the AgentX dashboard for ten seconds if time allows.');
}

// ---------- 9. Sponsor stack ----------
{
  const s = base(true);
  eyebrow(s, 'Built on the co-host stack', true);
  title(s, 'Every sponsor tool does real work.', true);
  const tools = [
    ['EdgeOne Makers', 'Agent runtime (session mode), custom MCP tools, Blob storage, AI Gateway models, streaming UI, tracing, one-command deploy.'],
    ['Memories.ai', 'Video Datalake: upload, index, summary and captions, frame extraction, image search across the claims collection for the fraud twin.'],
    ['AgentX', 'Self-hosted trace-eval: golden dataset, policy judge, deploy gate with no-regression check, online PII and secrets monitors.'],
    ['WorkBuddy', 'Refund Desk skill: pulls escalations, summarizes evidence and fraud matches, takes approve or deny, posts to Slack; daily .docx report.'],
    ['VeloDB', 'claims_events table and dashboard SQL: auto-approval by hour, refunded dollars, fraud clusters, p95 latency.'],
    ['AWS', 'S3 evidence archive on every upload (private, versioned, encrypted) and a CloudFormation stack for the EC2 host that runs AgentX and the live-evidence relay.'],
  ];
  const w = (W - 2 * M - 2 * 0.3) / 3, h = 1.85;
  tools.forEach((t, i) => {
    const x = M + (i % 3) * (w + 0.3), y = 2.25 + Math.floor(i / 3) * (h + 0.3);
    card(s, x, y, w, h, true);
    text(s, t[0], { x: x + 0.3, y: y + 0.25, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.ink });
    text(s, t[1], { x: x + 0.3, y: y + 0.7, w: w - 0.6, h: 1.1, fontSize: 11.5, color: C.ink2, lineSpacingMultiple: 1.15 });
  });
  footer(s, 9, true);
  s.addNotes('Name each tool and its job in one breath each. Nothing here is bolted on: remove any of them and a feature disappears.');
}

// ---------- 10. Close ----------
{
  const s = base(true);
  eyebrow(s, 'Why it wins, and what is next', true);
  text(s, [
    { text: 'Data → Intelligence → Experience → Execution → Transaction. ', options: { color: C.ink } },
    { text: 'One loop.', options: { color: C.aqua } },
  ], { x: M, y: 1.0, w: W - 2 * M, h: 1.6, fontFace: F.display, fontSize: 36, bold: true, valign: 'middle' });
  const w = (W - 2 * M - 2 * 0.3) / 3, y = 3.0, h = 2.6;
  [
    ['Why it wins', 'Returns fraud is a $101B problem with a named buyer on every marketplace. The demo reaches a transaction, and the fraud catch is a moment judges remember.'],
    ['Next 30 days', 'One pilot with a marketplace returns desk. Measure auto-approval rate, fraud catches and minutes saved per claim. AWS credits fund video volume, S3 and the AgentX host.'],
    ['Try it', 'Live demo: [demo URL]\nRepository: github.com/vnmoorthy/claimsight\nDeck and storyboard in docs/'],
  ].forEach((b, i) => {
    const x = M + i * (w + 0.3);
    card(s, x, y, w, h, true);
    text(s, b[0], { x: x + 0.3, y: y + 0.3, w: w - 0.6, h: 0.4, fontSize: 17, bold: true, color: C.accent });
    text(s, b[1], { x: x + 0.3, y: y + 0.8, w: w - 0.6, h: 1.7, fontSize: 13, color: C.ink2, lineSpacingMultiple: 1.25 });
  });
  text(s, 'Thank you.', { x: M, y: 6.2, w: 6, h: 0.6, fontFace: F.display, fontSize: 24, bold: true, color: C.ink });
  footer(s, 10, true);
  s.addNotes('End on the loop line. Say thank you and stop; leave time for one judge question.');
}

const out = path.join(__dirname, 'ClaimSight-deck.pptx');
pres.writeFile({ fileName: out }).then(() => console.log('wrote', out));
