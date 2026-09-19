# ClaimSight backend notes

Detailed notes on the agent, cloud functions, storage adapter and Memories.ai client, written during the build. The top-level README is the entry point; this file is the reference.

# ClaimSight

**An after-sales teammate that watches the customer's evidence video, applies the refund policy, executes the refund itself, and pulls a human in only when policy or fraud rules say so.**

Built on the EdgeOne Makers `claude-agent-starter-node` template: a Claude Agent SDK agent (through the Makers AI Gateway) with a custom MCP tool set, stateless cloud functions for orders / ledger / claims, Memories.ai Video Datalake for evidence understanding and cross-account fraud matching, AgentX traces for observability, and a React/Vite UI (chat + Decision Card + Refund Desk).

**Track:** AI Assistants · **Framework:** Claude Agent SDK · **Language:** TypeScript (Node ≥ 20)

## What happens on a claim

```
customer message (+ order id, evidence video)
        │
        ▼
POST /claims  ── agents/claims/index.ts (Claude Agent SDK, MCP server "claimsight", no shell/browser)
        │
        ├─ lookup_order      → orders:<id>            (Blob / memory)
        ├─ get_policy        → policy                 (data/policy.json)
        ├─ inspect_evidence  → Memories.ai summary + caption + moment frame
        ├─ fraud_check       → Memories.ai image search (frame_embedding) → video_index / GET /claims?video_id=
        ├─ execute_refund / create_replacement → POST /refund | /replacement   (server-side policy enforcement, ledger)
        ├─ escalate          → POST /claims-record (pending_review) + Slack webhook
        └─ record_decision   → POST /claims-record + POST /agentx-emit (OTLP trace: 1 agent span + 1 span per tool)
        │
        ▼
reply to the customer + fenced ```decision block  →  Decision Card in the UI
                                                 →  Refund Desk (GET /claims, POST /claims-decision) for humans
```

Decision procedure (system prompt, SPEC §3): lookup → policy → inspect evidence → fraud check → decide → execute → record → reply.

### Agent modes

`POST /claims` runs in one of two modes (logged per request as `mode=…`):

* **`llm`** — the Claude Agent SDK drives the eight `claimsight` MCP tools through the Makers AI Gateway (`AI_GATEWAY_MODEL`, SDK `fallbackModel`). Selected when `AGENT_MODE=llm` or a model key is present.
* **`deterministic`** — `agents/claims/_deterministic.ts` runs the same tool sequence in code (lookup → policy → evidence → fraud → decide → execute/escalate → record) through the same tool handlers, streams the same `tool_called` / `text_delta` / `decision` / `done` events, writes a plain-English explanation that cites the clauses, and ends with the identical ```decision block. Selected when `AGENT_MODE=deterministic`, or automatically when neither `AI_GATEWAY_API_KEY` nor `ANTHROPIC_API_KEY` is set. This is the offline rehearsal path and the on-stage fallback if the gateway is flaky.

Both modes honour `stream:false` (JSON `{text, decision, …}`) and `context.request.signal` (the `/stop` route).

| Situation | Action | Clauses |
|-----------|--------|---------|
| Delivered more than 30 days ago | deny | P1 |
| Worn apparel | deny | P6 |
| No damage visible / evidence not ready | escalate (recommend deny) | P2 |
| Evidence matches another account's video (score ≥ 0.80) | escalate (suspected fraud) | P5 |
| Damaged item worth more than $75 | escalate (recommend refund/replacement) | P3 |
| Kitchen / lighting item in stock | replacement | P2, P4 |
| Otherwise | refund of the item's line total | P2 (+P4 if replacement-first but out of stock) |

The server never trusts the agent: `POST /refund` rejects anything above the order total, anything above the auto-approve limit without `x-human-approved: true` (only the desk sends it), duplicate executions per claim, and cumulative refunds beyond the order total.

## Architecture

```
claimsight/
├── agents/                              # stateful Makers agents (SSE)
│   ├── claims/index.ts                  # POST /claims — the ClaimSight agent (+ stream:false JSON mode for eval)
│   ├── claims/_tools.ts                 # the 8 MCP tools + per-claim state (model-free, scriptable)
│   ├── chat/, stop/                     # template chat agent (kept) and /stop
│   ├── _kv.ts, _memories.ts, _policy.ts # storage adapter, Memories.ai client, policy derivations
│   └── _model.ts, _logger.ts, _redact.ts
├── cloud-functions/                     # stateless Node functions (JSON)
│   ├── seed/ orders-lookup/ upload-evidence/ evidence-status/ refund/ replacement/
│   ├── claims/ (GET) claims-record/ claims-decision/ stats/ agentx-emit/ demo-evidence/
│   ├── _kv.ts, _memories.ts             # verbatim copies of the agents/ helpers (bundles are built separately)
│   └── _ledger.ts                       # refund/replacement enforcement shared by /refund, /replacement, /claims-decision
├── data/
│   ├── orders.json, policy.json         # seed data (12 orders / 6 customers; policy P1–P6)
│   ├── demo_evidence.json               # "Use demo clip" list [{label, video_id, order_id}]
│   ├── golden_claims.json               # eval cases (eval/)
│   └── stubs/*.json                     # canned Memories.ai responses (MEMORIES_STUB=1)
├── src/                                 # React/Vite UI: chat + evidence upload + Decision Card + /desk
├── eval/                                # AgentX eval + monitors (Python)
├── workbuddy/refund-desk/               # WorkBuddy skill for reviewers
└── velodb/                              # optional analytics schema/loader
```

### Storage

The claims store (`_kv.ts`) is a tiny `get / set / delete / list(prefix)` adapter with three backends, selected once per process and logged once (`[storage] backend=…`):

| Backend | When | Notes |
|---------|------|-------|
| `blob` | `@edgeone/pages-blob` → `getStore({ name: CLAIMS_BLOB_STORE, consistency: "strong" })` succeeds (project linked / deployed) | records are key prefixes: `orders/<id>.json`, `claims/<id>.json`, `video_index/<vid>.json`, `ledger/<txn>.json`, `counters.json`, `policy.json` |
| `kv` | a console-bound KV global named by `CLAIMS_KV` exists (Edge runtime style `put/get/delete/list`) | keys `orders__A1042` … |
| `memory` | `STORAGE=memory`, or the Blob probe throws (not linked, no credentials) | module-level Map, auto-seeded from `data/*.json`; not persistent and not shared across processes |

`STORAGE=auto` (default) tries KV, then Blob, then memory. Logical keys follow SPEC §1 (`orders:<id>`, `claims:<id>`, `video_index:<video_id>`, `ledger:<txn>`, `counters`, `policy`).

### Memories.ai

`_memories.ts` talks to the Video Datalake (`MEMORIES_BASE`, header `Authorization: <MEMORIES_API_KEY>` — the raw key): `POST /videos` (multipart `json` + `file`), `GET /operations/{op}`, `GET /videos/{id}/summary`, `GET /videos/{id}/caption`, `GET /moments/{video_id}@{start}-{end}?expand=caption,frame`, `POST /search` with `{collection_id, query_images:[frame_url], targets:["frame_embedding"], top_k}`. With `MEMORIES_STUB=1` (or no key) every call returns the API-shaped canned responses in `data/stubs/` keyed by video id, uploads map an order id to a stub video, and operations progress `preprocess → index → derive` over `MEMORIES_STUB_INDEX_SECONDS`. The whole flow runs offline.

## Run locally

Prerequisites: Node ≥ 20, `npm i -g edgeone`.

```bash
npm install
cp .env.example .env            # fill in AI_GATEWAY_API_KEY; keep MEMORIES_STUB=1 for the offline rehearsal
edgeone login                   # once; agents need the Makers AI Gateway key sync
PAGES_SOURCE=skills edgeone makers dev -n claimsight
```

Always pass `-n claimsight` (bare `edgeone makers dev` opens an interactive link picker that hangs in non-interactive shells; `-n` auto-creates/links the project). The dev server serves the UI, agents and cloud functions on http://localhost:8088. `edgeone makers dev` requires a logged-in account (or `-t <token>`); the Blob backend additionally needs the project linked — without it the store falls back to the in-memory Map automatically.

Rehearsal without network (everything stubbed):

```bash
curl -s -X POST localhost:8088/seed -H 'Content-Type: application/json' -d '{}'
curl -s -X POST localhost:8088/orders-lookup -H 'Content-Type: application/json' -d '{"order_id":"A1042"}'
curl -s -X POST localhost:8088/claims -H 'Content-Type: application/json' -H 'makers-conversation-id: eval-1' \
     -d '{"message":"My mug arrived chipped","order_id":"A1042","evidence_video_id":"vid_stub_mug_alice","stream":false}'
curl -s 'localhost:8088/claims?status=pending_review'
curl -s localhost:8088/stats
```

Seed scenarios (`data/orders.json`; delivery dates are relative to the moment `/seed` runs):

| Order | Customer | Item | Scenario |
|-------|----------|------|----------|
| A1042 | c_alice | MUG-01 $24, 3 days ago, backordered | clean auto-approve → refund (P2, P4 considered) |
| A1043 | c_mallory | MUG-01 $24, 3 days ago | same footage as A1042 → escalate (P5) |
| A1050 / A1048 | c_carol / c_bob | HDPH-02 $129 | above limit → escalate (P3) |
| A1045 / A1051 / A1046 | c_carol / c_mallory / c_dave | LAMP-03 $59 / MUG-01 ×2, in stock | replacement-first (P4) |
| A1061 / A1049 | c_dave / c_alice | LAMP-03 45 days / VASE-05 40 days | outside window → deny (P1) |
| A1077 / A1047 | c_erin | TSHIRT-04 (worn) | non-returnable → deny (P6) |
| A1044 | c_bob | VASE-05 $85 | above limit → escalate (P3) |

Demo clips (`data/demo_evidence.json`) point at the stub video ids (`vid_stub_mug_alice`, `vid_stub_mug_mallory`, `vid_stub_headphones_crack`, `vid_stub_lamp_dent`, `vid_stub_tshirt_worn`, `vid_stub_vase_crack`, `vid_stub_no_damage`).

### Pre-indexing evidence (live Memories.ai)

1. Create a collection in the Memories.ai console → `MEMORIES_CLAIMS_COLLECTION=col_…`, set `MEMORIES_API_KEY`, unset `MEMORIES_STUB`.
2. Upload each demo clip through `POST /upload-evidence` (multipart `file`, `order_id`) or the console; poll `POST /evidence-status` until `done`.
3. Put the returned `vid_…` ids into `data/demo_evidence.json`. Cloud functions accept request bodies up to 6 MB — pre-index bigger clips and pick them from the dropdown.

## Deploy

```bash
PAGES_SOURCE=skills edgeone makers env set MEMORIES_API_KEY "sk-mai-…"      # and the other non-gateway vars below
PAGES_SOURCE=skills edgeone makers env set SELF_BASE_URL "https://<project>.edgeone.run"
PAGES_SOURCE=skills edgeone makers deploy
```

`AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` are auto-provisioned from `.env.example`; everything else is set with `edgeone makers env set`. Install nothing extra: `@edgeone/pages-blob` (Blob) and `@anthropic-ai/claude-agent-sdk` are already dependencies.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL` | — / `https://ai-gateway.edgeone.link/v1` | Makers AI Gateway (auto-provisioned on deploy) |
| `AI_GATEWAY_MODEL` | `@makers/deepseek-v4-pro` | claims agent model; `AI_GATEWAY_FALLBACK_MODEL` (`@makers/kimi-k2.6`) is passed as the SDK `fallbackModel` |
| `AGENT_MODE` | auto | `llm` or `deterministic`; unset ⇒ deterministic when no `AI_GATEWAY_API_KEY` / `ANTHROPIC_API_KEY` is configured (see Agent modes) |
| `MEMORIES_API_KEY` | — | Memories.ai key (`Authorization: <key>`); unset ⇒ stub mode |
| `MEMORIES_BASE` | `https://api.memories.ai/serve/datalake/v1` | Datalake base URL |
| `MEMORIES_CLAIMS_COLLECTION`, `MEMORIES_CATALOG_COLLECTION` | — | collection ids (evidence / optional catalog) |
| `MEMORIES_STUB` | — | `1` ⇒ canned responses from `data/stubs/` (`MEMORIES_STUB_INDEX_SECONDS` controls the fake indexing time) |
| `FRAUD_SIMILARITY_THRESHOLD` | `0.80` | frame-embedding score that counts as a match (P5) |
| `SELF_BASE_URL` | `http://localhost:8088` (else the request origin) | where the agent reaches `/refund`, `/replacement`, `/claims-record`, `/agentx-emit` |
| `UI_BASE_URL` | `SELF_BASE_URL` | public UI origin for the Slack link (`<UI>/desk`) |
| `SLACK_WEBHOOK_URL` | — | optional incoming webhook for escalations |
| `AGENTX_OTLP_URL`, `AGENTX_API_KEY` | `http://localhost:4700/api/v1/otel/v1/traces` / — | OTLP/HTTP JSON traces; skipped silently when both are unset or the collector is unreachable |
| `ADMIN_TOKEN` | — | protects `POST /seed` and `POST /claims-record` (`x-admin-token`); open when unset |
| `STORAGE` | `auto` | `auto` / `blob` / `kv` / `memory` (see Storage) |
| `CLAIMS_BLOB_STORE`, `CLAIMS_KV` | `claimsight` / `CLAIMS_KV` | Blob store name / KV global name |
| `PAGES_BLOB_PROJECT_ID`, `PAGES_BLOB_TOKEN` | — | optional external Blob access from local scripts |
| `VELODB_HOST`, `VELODB_PORT`, `VELODB_USER`, `VELODB_PASSWORD`, `VELODB_DB` | `9030` | optional analytics (`velodb/`) |

Secrets live only in the agent / cloud-function env: the model never sees them (the agent has no shell or file tools, and the Claude CLI subprocess env is scrubbed of `MEMORIES_API_KEY`, `SLACK_WEBHOOK_URL`, `AGENTX_API_KEY`, `ADMIN_TOKEN`, …).

## Endpoints

| Route | Method | Body / query | Returns |
|-------|--------|--------------|---------|
| `/claims` | POST (agent) | `{message, order_id?, evidence_video_id?, email?, stream?, userId?, userMsgId?, botMsgId?}` + header `makers-conversation-id` | SSE (`claim`, `text_delta`, `tool_called`, `decision`, `done`, …). With `stream:false`: JSON `{status, text, decision, claim_id, claim_status, trace_id, tool_calls, latency_ms, error?}` |
| `/stop` | POST | `{conversation_id}` | aborts the active run (template) |
| `/seed` | POST | `{clear_claims?}` · header `x-admin-token` when `ADMIN_TOKEN` is set | loads orders + policy, resets counters (idempotent) |
| `/orders-lookup` | POST / GET | `{order_id, email?}` / `?order_id=` | order record (+ `days_since_delivery`) or 404 |
| `/upload-evidence` | POST multipart | `file` (mp4/mov/webm), `order_id` | `202 {video_id, operation}` (proxied to Memories.ai; key stays server-side) |
| `/evidence-status` | POST / GET | `{operation, video_id}` | `{done, stage, progress:{preprocess,index,derive,percent}, summary?, caption?, caption_segments?}` |
| `/refund` | POST | `{order_id, amount, reason, claim_id}` · header `x-human-approved: true` for amounts above the limit | `{txn_id, amount, status:"refunded", method:"refund", …}` or 403 (`requires_human_approval`, `amount_exceeds_order_total`, `order_refund_exhausted`) |
| `/replacement` | POST | `{order_id, sku, claim_id, reason?}` | same shape with `method:"replacement"`; 409 `out_of_stock` |
| `/claims` | GET | `?status=&video_id=&order_id=&customer_id=&limit=` | `{claims:[…], count}` newest first |
| `/claims-list` | GET | same as `GET /claims` | alias, in case a deployment routes every `/claims` method to the agent |
| `/claims-record` | POST | `{claim}` · `x-admin-token` | upserts `claims:<id>` + `video_index`, bumps counters (used by the agent's `escalate` / `record_decision`) |
| `/claims-decision` | POST | `{claim_id, decision:"approve"\|"deny", note?}` | applies the human decision (approve executes the recommended refund/replacement with human approval) |
| `/stats` | GET | — | `{counters, derived:{auto_approval_pct, refunded_total, fraud_flags, pending_review, median_latency_ms, p95_latency_ms}, recent:[last 20]}` |
| `/agentx-emit` | POST | `{claim}` | posts one OTLP trace (agent span + tool spans) → `{emitted, trace_id, spans}` |
| `/demo-evidence` | GET | — | `{items:[{label, video_id, order_id}]}` from `data/demo_evidence.json` |
| `/history`, `/conversations`, `/clear-history`, `/delete-conversation` | POST | template conversation store endpoints | |

The final assistant message of every claim ends with:

```decision
{"claim_id":"clm_…","action":"refund|replacement|escalated|denied","amount":24,"policy_clauses":["P2","P4"],"evidence":"white ceramic mug, chip on rim at 0:03","fraud_matches":0,"txn_id":"txn_…","latency_ms":18342}
```

If the model omits it, the handler appends the block recorded by `record_decision`, so the Decision Card and the eval harness always get one.

## Evaluation and reviewers

* `eval/run_eval.py` posts each golden case to `POST /claims` with `stream:false` (conversation id `eval-<case id>`; pass `order_id` and the stub `evidence_video_id` from `data/demo_evidence.json`) and judges the returned `{text, decision}`; `eval/monitors.py` enables the AgentX built-in scorers.
* `workbuddy/refund-desk/` lets a manager review `GET /claims?status=pending_review` and post decisions to `POST /claims-decision` from WorkBuddy; the UI offers the same at `/desk`.
* `velodb/` (optional) loads `GET /claims` into VeloDB for dashboards.

## License

MIT.

## Loop 1 polish (client-facing demo)

What changed in the backend contract for the demo pass. Nothing under `src/` was touched; the fields below are additive so older records and clients keep working (`listClaims` backfills `display_id` / `mode_label` on read).

### Product-voice reasons

Every `reason` string that reaches the customer or the Decision Card is one plain-English sentence with no video ids, customer ids, claim ids, thresholds or error codes — those stay in structured fields (`fraud.matches[].video_id`, `error`, `detail`). This covers the deterministic engine, the tool outputs the model sees, and the Slack text:

| Where | Before | Now |
|-------|--------|-----|
| `fraud_check.reason` | `Evidence matches vid_stub_mug_alice (score 0.93, customer c_alice, order A1042) …` | `Evidence matches footage submitted for order A1042 by another customer (similarity 0.93)` |
| `execute_refund` / `create_replacement` rejection | server message only | adds `reason` (`Refund needs a teammate: a refund was already issued for this order`), keeps the code in `error` and the server text in `detail` |
| evidence not ready | `Evidence could not be reviewed (video_not_ready)` | `The evidence video is still being processed` |
| customer reply on escalation | `Your claim reference is clm_…` | `Your claim reference is C-A1043-F809` |

The system prompt (LLM mode) now spells out the same rule for `escalate.reason` / `record_decision.reason`.

### Friendly ids, names, frames, mode labels

* **`display_id`** = `C-<order_id>-<4 uppercase hex>` (e.g. `C-A1043-F809`), derived from the tail of `claim_id` (`displayIdFor` in `_kv.ts`; non-hex tails such as the seeded `clm_seed_alice_mug` hash to 4 hex digits; no order → `C-<hex>`). Present on claim records, the ```decision block, `/claims-list`, `/claims-record`, `/claims-decision`, `fraud.matches[].display_id`, the `claim` / `decision` SSE events, the `stream:false` response, the Slack line and the AgentX root span (`claimsight.display_id`). `claim_id` stays the API key everywhere.
* **`customer_name`** lives on each order in `data/orders.json` (names match the existing `customers` map: Alice Moreno, Mallory Quinn, Bob Okafor, Carol Nguyen, Dave Lindqvist, Erin Patel; `customer_id` keys unchanged) and is carried through `OrderRecord`, `lookup_order`, claim records, `/claims-list`, `fraud.matches[].customer_name`, the block and Slack.
* **Evidence frames.** `data/stubs/moments.json` points at same-origin posters `/evidence/frames/<video_id>/{0,3}.jpg` (files under `public/evidence/frames/`; the second frame is always `t=3` now — the `2.jpg`/`4.jpg` references had no files). `inspect_evidence` returns `frames: [{t,url}]` and `frame_url` (the `t=3` frame when present, else the first); the claim record stores `evidence_frame_url`, which is also in the block and `/claims-list`. The stub fraud search still keys off the `/frames/<video_id>/` segment of the query URL, so A1043 keeps detecting the A1042 twin. `data/demo_evidence.json` items carry `frame_url` for the dropdown.
* **Mode labels.** `mode: 'deterministic' | 'llm'` is unchanged; `mode_label` is `Policy engine` or `AI model · <model id>` on the `stream:false` response, the `claim` and `decision` SSE events, the block, claim records and `/stats` (`mode` / `mode_label` of the most recent claim). `/stats` also returns `backend_label`: `Demo data` when storage is `memory` or Memories.ai is stubbed, otherwise `Live`.
* **Decision block** now: `{claim_id, display_id, order_id, customer_name, action, amount, policy_clauses, reason, evidence, evidence_frame_url, fraud_matches, txn_id, latency_ms, mode, mode_label}`. The wrapper still appends it from recorded state when the model omits it.

### Fraud-twin resolution

`fraud_check` maps a matched video to its claim through `GET /claims-list?video_id=` first (the cloud-function store is the source of truth; locally the agent and the functions keep separate in-memory maps) and only then the agent-local `video_index` (seeded stubs). In a demo session the A1043 escalation therefore names the A1042 claim the audience just saw (`matches C-A1042-7AB0`), not the seed placeholder.

### Slack escalation

One line, product voice, built in `escalate` (`agents/claims/_tools.ts`):

```
ClaimSight needs a decision — C-A1043-F809 · Mallory Quinn · $24.00 mug · Reason: Evidence matches footage submitted for order A1042 by another customer (similarity 0.93) · Fraud: matches C-A1042-7AB0 (similarity 0.93) · Open the desk: http://localhost:5173/#desk?claim=clm_…
```

The link uses `PUBLIC_UI_URL` (new in `.env.example`, default `http://localhost:5173`; `UI_BASE_URL` remains a legacy fallback). The tool result exposes `slack_text` and `desk_url`; `SLACK_WEBHOOK_URL` unset → `slack_notified:false` with no error. The reviewer paragraph passed as `escalate(summary)` is stored as `decision.note`.

### `needs_info` (unknown order / no evidence)

`POST /claims` with an order id that does not exist answers with one customer sentence — `I couldn't find order A9999 — check the number on your confirmation email.` — and **no ledger side effects** (`/stats.derived.refunded_total` unchanged, no `/refund` call, no `video_index` write). The claim is still recorded so the desk shows it: `status: "needs_info"` (new member of the status union; `/claims-record` accepts it with an empty `customer_id`), `decision.action: "needs_info"`, and a decision block with `action: "needs_info"`. `stream:false` returns `{status:"ok", claim_status:"needs_info", decision:{action:"needs_info", display_id:"C-A9999-…", …}}`; the SSE stream emits the same `decision` event. The same path parks a claim when no video/evidence summary is attached (`kind: "evidence_missing"`). These records bump `counters.needs_info` instead of `counters.claims`, so the auto-approval rate is not diluted; `/stats.derived.needs_info` counts them. In LLM mode `lookup_order` sets the state and the wrapper (`finalizeNeedsInfo`) records it after the model replies. `POST /orders-lookup` uses the same 404 shape and sentence: `{error:"order_not_found", message:"I couldn't find order A9999 — check the number on your confirmation email.", order_id, found:false}`; hits return `found:true` plus the order.

### LLM readiness

`buildSystemPrompt` (`agents/claims/index.ts`) was rewritten for production tone: no demo language, fixed tool order (lookup → policy → inspect → fraud → decide → execute/escalate → record), facts only from tool results, product-voice reasons, customer reply under 120 words that quotes the `display_id` (never the internal claim id), and a final fenced block copied verbatim from `record_decision` (which already carries `display_id`, `mode_label`, `evidence_frame_url`). Tool schemas are unchanged except for the added output fields. Untested end-to-end against a live gateway in this loop (no model key configured locally); the deterministic engine exercises the same tool handlers and the golden set passes 30/30.

## Blender integration

Two Blender pipelines (`blender/README.md`) are wired into the backend: the **Damage Twin** — a 3D receipt rendered for every decided claim — and the **Synthetic Evidence Lab** — labelled twin clips that measure the fraud-twin detector. Nothing under `src/` changed; every field below is additive.

### Damage Twin (claim → render service → record)

```
record_decision (agents/claims/_twin.ts)            scripts/render-service.ts (:8090, concurrency 1)
  build spec from the claim + evidence  ──POST /render/twin {claim_id, spec}──▶  queue → blender -b -P blender/damage_twin.py
  twin = {status:"queued", requested_at}  ◀──202 {job_id, status:"queued"}──     public/twins/<claim_id>.mp4 + .png
  POST /claims-record {claim + twin}                                              ──POST /twin-ready {claim_id, video_url, poster_url, render_ms}──▶ twin.status "ready"
                                                                                  (or {claim_id, error} → "failed")
```

* **Record shape.** Claim records, `/claims-list` items and the fenced ```decision block carry `twin: {status, video_url?, poster_url?, requested_at?, ready_at?, render_ms?, error?}` with `status` ∈ `queued | rendering | ready | failed | unavailable | skipped`. Older records and `needs_info` records read as `{status:"unavailable"}` (`withDisplayFields` backfills it). `POST /claims-record` accepts `twin` on the body (validated by `normalizeTwin`) and keeps the stored one when the body has none.
* **When a twin is requested.** `record_decision` builds the spec and asks the render service only for real decisions (refund / replacement / escalated / denied) with evidence (a ready video, or the intake summary). The request has a 2 s budget (`TWIN_REQUEST_TIMEOUT_MS`); unreachable, slow, rejected or `TWIN_RENDER_URL=off` ⇒ `twin.status "unavailable"` with the reason in `twin.error`. The claim never waits for or fails on the render: the block answers with `twin:{status:"queued"}` (or `unavailable`) and the UI polls `GET /claim` until `ready`. **Opt-out for evaluations:** body `skip_twin: true` or header `x-claimsight-eval: 1` on `POST /claims` records `twin:{status:"skipped"}` and never contacts the render service — `eval/run_eval.py` sends the header, and the golden-check snippet below should too, so only real demo claims render.
* **Spec mapping** (`buildTwinSpec`): `product` from the SKU prefix (MUG→mug, HDPH→headphones, LAMP→lamp, VASE→vase, TSHIRT→tshirt, else generic); `damage_location` = the first location keyword valid for that product (rim/handle/base, hinge/headband/cup, shade/stem/base, body/neck/base, collar/fabric/sleeve) found in a non-negated evidence clause that mentions damage, else the product's first location; `damage_type` = the earliest chip/crack/dent/scuff/tear/stain/scratch/bend in a non-negated clause, else `damage`; `evidence_time` = the first `m:ss` in the caption/timeline, else the first damage segment's start; plus `evidence_line`, `action`, `amount`, `txn_id`, `policy_clauses`, `display_id`, `order_id`, `customer_name`, `frame_url` (= `evidence_frame_url`). `color` is left unset (product default). Stub demo clips resolve to mug chip@rim 0:03, headphones crack@headband 0:04, lamp dent@shade 0:02, vase crack@base 0:02, t-shirt stain@collar 0:03.
* **`GET /claim?claim_id=…`** (`cloud-functions/claim`, also `POST {claim_id}`): one full record with the display fields and `twin` backfilled; 404 `claim_not_found`. **`POST /twin-ready`** (`cloud-functions/twin-ready`): `{claim_id, video_url, poster_url, render_ms}` → `ready` (+ `ready_at`), `{claim_id, error}` → `failed`, `{claim_id, status:"rendering"}` → `rendering`; only the `twin` field changes; returns `{ok, claim_id, display_id, twin, claim}`; protected by `x-admin-token` when `ADMIN_TOKEN` is set (same helper as `/seed`). Both are registered in `scripts/local-harness.ts`, which now also serves `public/twins/`, `public/lab/` and `public/evidence/` statically (Range requests supported) so `curl :8088/twins/<id>.mp4` works without Vite.
* **Render service** (`npm run render:service`, `scripts/render-service.ts`, port `RENDER_PORT` = 8090): `GET /health` → `{ok, blender:{found, path}, queue}`; `POST /render/twin {claim_id, spec}` → `202 {job_id, status:"queued"}` immediately (idempotent while a job for that claim is queued/rendering; `503 blender_not_found` when Blender is missing); `GET /render/status/<claim_id>` → `{status, video_url?, poster_url?, error?}`. One Blender process at a time and at most `TWIN_MAX_QUEUE` (8) pending jobs — beyond that `POST /render/twin` answers `429 {error:"queue_full"}` (the claim records `unavailable`) so a runaway loop can never block a stage demo; defaults 800×450 · 20 fps · 4 s · 12 samples (`TWIN_WIDTH/HEIGHT/FPS/DURATION/SAMPLES`), `BLENDER_BIN` (default `/Applications/Blender.app/Contents/MacOS/Blender`, else `blender` on PATH), `TWIN_RENDER_TIMEOUT_MS` (10 min). `spec.frame_url` that is http(s) is downloaded to a temp file; a `/evidence/…` path is resolved under `public/` (or fetched from `CLAIMSIGHT_URL`). Output goes to `public/twins/<claim_id>.mp4` + `.png` (rendered in a temp dir, copied when complete); then `POST ${CLAIMSIGHT_URL}/twin-ready` (default `http://localhost:8088`, `ADMIN_TOKEN` forwarded; a 404 is retried, the record is written right after the request). Before rendering it asks `GET /claim` and skips claims that were wiped by a `/seed` in between. One log line per job with timing: `job=… claim=… mug chip@rim status=ready total=24.3s blender=23.1s -> /twins/<id>.mp4 callback=ok`.
* **Env.** `TWIN_RENDER_URL` (agent → render service, default `http://localhost:8090`), `TWIN_REQUEST_TIMEOUT_MS`, `RENDER_PORT`, `BLENDER_BIN`, `CLAIMSIGHT_URL`, `TWIN_*`, `MEMORIES_LAB_COLLECTION` — all in `.env.example`. Local run: `npm run render:service` in one terminal, `TWIN_RENDER_URL=http://localhost:8090 npm run dev:local` in another.

### Synthetic Evidence Lab (`npm run lab`)

```bash
npm run lab -- --count 24 --seed 7            # render 24 clips (twin-rate 1.0, damaged-rate 0.7) + score + report
npm run lab -- --count 24 --seed 7 --reuse    # skip the render when blender/out/lab/manifest.json exists
python eval/lab_eval.py                       # optional: AgentX dataset "ClaimSight fraud-twin lab" + gated run (needs AGENTX_API_KEY)
```

`scripts/lab.ts` runs `blender/synth_evidence.py`, then scores every ordered pair of clips (positive = same `group_id`) with one of two detectors: **memories.ai** when `MEMORIES_API_KEY` is set and `MEMORIES_STUB` is not `1` — every clip is uploaded into the lab collection (`MEMORIES_LAB_COLLECTION`, else a new `claimsight-lab` collection whose id is printed), indexing operations are awaited, and each clip's first frame (`getMoment(video, 0, 2, ['frame'])`) is searched against the collection with the same `searchByImage` (top_k 10) call the agent's `fraud_check` makes; otherwise the **local baseline** — a 64-bit dHash plus an 8×8 mean-colour signature of each poster PNG (decoded in-process, no native deps), `score = 0.7 · (1 − Hamming/64) + 0.3 · colour similarity`, taking the better of the plain and horizontally-flipped hash so mirrored twins are not penalised. Thresholds 0.50…0.98 (step 0.02) give recall / FPR / precision / F1 plus recall on mirrored twins; `recommended_threshold` is the best F1 (ties → the higher threshold). Output: `public/lab/results.json` (`{generated_at, detector, collection_id?, options, clips[], curve[], recommended_threshold, twin_pairs[], summary}`), posters and clips copied to `public/lab/clips/<clip_id>.{png,mp4}`, and a summary table on stdout. `eval/lab_eval.py` turns `twin_pairs` into an AgentX dataset with one case per pair and a code scorer (10 when detected at the recommended threshold, else 0), gated at `fail_under=8`; it exits 0 with a note when `AGENTX_API_KEY` is unset.

Golden check with the twin opt-out (31 cases, expect 0 mismatches; nothing is rendered):

```python
import json, urllib.request
B = "http://localhost:8088"
def post(p, b, h={}):
    r = urllib.request.Request(B + p, data=json.dumps(b).encode(), headers={"Content-Type": "application/json", **h}, method="POST")
    return json.load(urllib.request.urlopen(r, timeout=120))
cases = json.load(open("data/golden_claims.json"))
bad = []
for c in cases:
    post("/seed", {})
    r = post("/claims", {"message": c["message"], "order_id": c["order_id"], "evidence_video_id": c.get("evidence_video_id"), "stream": False},
             {"Makers-Conversation-Id": "g-" + c["id"], "x-claimsight-eval": "1"})
    if (r.get("decision") or {}).get("action") != c["expected_action"]: bad.append(c["id"])
print(len(cases), "cases", len(bad), "mismatches", bad)
```
