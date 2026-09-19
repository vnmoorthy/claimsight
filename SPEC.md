# ClaimSight — technical spec (build contract)

**One-liner:** An after-sales teammate that watches the customer's evidence video, applies the refund policy, executes the refund itself, and pulls a human in only when policy or fraud rules say so.

**Track:** 1 (AI Assistants) by default. Keep the production-pipeline story (AgentX gate + monitors) strong enough to re-file under Track 2 if that field is thin at 2:30 PM.

**Base:** this folder is the EdgeOne Makers `claude-agent-starter-node` template (Claude Agent SDK through the Makers AI Gateway, SSE streaming chat, React/Vite UI, sandbox tools via MCP, conversation store). Keep its conventions: `agents/<name>/index.ts` → `POST /<name>` (session mode, `Makers-Conversation-Id` header), `cloud-functions/<name>/index.ts` → `/<name>` (stateless, `onRequestPost`/`onRequestGet`), files prefixed `_` are private modules. Do NOT delete the template's `chat` agent; add alongside it.

## 1. Data model (Makers KV, namespace bound as env var `CLAIMS_KV`; fall back to an in-memory Map when the binding is absent so `edgeone makers dev` works without console setup)
Keys (all values JSON):
- `policy` → `data/policy.json` (see §5).
- `orders:<order_id>` → order record: `{order_id, customer_id, email, placed_at, status, items:[{sku, name, qty, unit_price, category}], total, currency, shipping_address, delivered_at}`.
- `claims:<claim_id>` → `{claim_id, order_id, customer_id, sku, video_id, evidence_summary, damage_assessment, fraud:{checked, matches:[{video_id, claim_id, score, customer_id}]}, decision:{action, amount, reason, policy_clauses:[...], by:"agent"|"human", txn_id?}, status:"auto_approved"|"pending_review"|"approved"|"denied"|"replacement", created_at, decided_at?, latency_ms, conversation_id}`.
- `video_index:<video_id>` → `{claim_id, order_id, customer_id}` (reverse lookup used by fraud check).
- `ledger:<txn_id>` → `{txn_id, order_id, amount, currency, method:"refund"|"replacement", created_at}`.
- `counters` → `{claims, auto_approved, escalated, denied, refunded_total, fraud_flags}`.

## 2. Cloud functions (stateless)
- `POST /seed` → loads `data/orders.json` + `data/policy.json` into KV, resets counters. Idempotent. Protect with header `x-admin-token: $ADMIN_TOKEN` (skip check if env unset).
- `POST /orders/lookup` `{order_id, email?}` → order or 404. (Also used by the UI.)
- `POST /upload-evidence` (multipart: `file`, `order_id`) → proxies to Memories.ai `POST {MEMORIES_BASE}/videos` as multipart (`json` part = `{collection_id: MEMORIES_CLAIMS_COLLECTION, fps: 1, metadata:{title: order_id}}`, `file` part) → returns `{video_id, operation}`. Never expose `MEMORIES_API_KEY` to the browser.
- `POST /evidence-status` `{operation, video_id}` → polls `GET /operations/{op}`; when done, fetches `GET /videos/{id}/summary` and `/caption` and returns `{done, progress, summary?, caption?}`.
- `POST /refund` `{order_id, amount, reason, claim_id}` → server-side policy enforcement (amount ≤ order total; ≤ policy.auto_approve_limit unless header `x-human-approved: true`), writes `ledger:<txn>` and updates `counters`; returns `{txn_id, amount, status:"refunded"}`.
- `POST /replacement` `{order_id, sku, claim_id}` → same shape with `method:"replacement"`.
- `GET /claims?status=` → list claims (newest first). `POST /claims/decision` `{claim_id, decision:"approve"|"deny", note}` → applies human decision (calls /refund with `x-human-approved` when approving), updates status, appends to `counters`.
- `GET /stats` → counters + last 20 claims (the UI stats strip; VeloDB is optional on top).
- `POST /agentx-emit` `{claim}` → posts one OTLP/HTTP JSON trace to `${AGENTX_OTLP_URL}` (default `http://localhost:4700/api/v1/otel/v1/traces`) with header `x-api-key: $AGENTX_API_KEY`; one span per tool call + a root `agent` span; silently no-op if env unset or unreachable. The agent calls this at the end of every claim.

## 3. Agent `agents/claims/index.ts` → `POST /claims`
Body: `{message, order_id?, evidence_video_id?, userId?, userMsgId?, botMsgId?}`. Reuse `_stream.ts` for SSE. System prompt: "You are ClaimSight, the after-sales teammate for <store>. Verify evidence, apply policy exactly, execute the decision, explain it plainly. Never invent tool results." Expose a custom MCP server (via `createSdkMcpServer` + `tool()` from the Claude Agent SDK, zod schemas) with tools:
- `lookup_order({order_id, email?})` → KV.
- `get_policy()` → KV `policy`.
- `inspect_evidence({video_id})` → Memories.ai summary + caption + entities; returns `{description, timeline:[{start,end,text}], products_seen:[...], damage_observed:[...]}`; plus a `frame_url` from `GET /moments/{video_id}@0-10?expand=frame` (first frame URL) for the fraud check.
- `fraud_check({video_id, order_id})` → Upload nothing; call `POST /search` with `{collection_id, query_images:[frame_url], targets:["frame_embedding"], top_k:10}`; drop results from the same `video_id`; map hits through `video_index:*`; return matches with `score ≥ FRAUD_SIMILARITY_THRESHOLD` (default 0.80) and their `customer_id`s; `is_suspicious = any match with a different customer_id` (or same customer, different order).
- `execute_refund({order_id, amount, reason, claim_id})` / `create_replacement(...)` → call the cloud functions via `fetch(process.env.SELF_BASE_URL + '/refund')`.
- `escalate({claim_id, reason, recommended_action})` → set claim `pending_review`, POST Slack incoming webhook (`SLACK_WEBHOOK_URL`, optional) with a one-paragraph summary + evidence summary + fraud matches + "Reply in WorkBuddy Refund Desk or open <UI>/desk".
- `record_decision({...})` → writes `claims:<id>`, `video_index`, counters, latency; calls `/agentx-emit`.
Decision procedure the prompt must follow: lookup → policy → inspect evidence → fraud check → decide (auto-approve if damage confirmed ∧ within window ∧ amount ≤ limit ∧ not suspicious; replacement if policy says replacement-first and in stock; escalate otherwise) → execute → record → reply. The final assistant message MUST end with a fenced block:
```decision
{"claim_id":"...","action":"refund|replacement|escalated|denied","amount":24.0,"policy_clauses":["P2","P4"],"evidence":"white ceramic mug, chip on rim at 0:03","fraud_matches":0,"txn_id":"txn_...","latency_ms":18342}
```
The UI parses that block into a Decision Card. `maxTurns` 12. Use `AI_GATEWAY_MODEL` default `@makers/deepseek-v4-pro` (fallback `@makers/kimi-k2.6`). Keep `context.tools` sandbox MCP OUT of this agent (least privilege: the refund agent gets no shell/browser).

## 4. Frontend (React, extend the template; keep it simple)
- Chat page: add "Attach evidence video" (file input, mp4/mov) → `/upload-evidence` → progress pill "Indexing evidence: preprocess → index → derive" via `/evidence-status` polling every 2 s → when ready, auto-send the pending message with `evidence_video_id`. Also a "Use demo clip" dropdown fed by `data/demo_evidence.json` (`[{label, video_id, order_id}]`) that skips upload (stage fallback).
- Decision Card component: renders the parsed `decision` block (action badge, amount, policy clauses, evidence line, fraud matches, txn id, latency).
- `/desk` view (route or tab): Refund Desk — table of claims from `GET /claims`, filter by status, Approve/Deny buttons → `POST /claims/decision`; auto-refresh every 5 s; stats strip from `GET /stats` (auto-approval %, refunded $, fraud flags, median latency).

## 5. Seed data (`data/`)
- `orders.json`: 12 orders across 6 customers; SKUs: MUG-01 white ceramic mug $24, HDPH-02 headphones $129, LAMP-03 desk lamp $59, TSHIRT-04 $19 (category apparel, non-returnable if worn), VASE-05 $85. Include `A1042` (mug, delivered 3 days ago, customer c_alice), `A1043` (mug, delivered 3 days ago, customer c_mallory — the fraud twin), `A1050` (headphones $129, > limit → escalate), `A1061` (lamp delivered 45 days ago → outside window), `A1077` (t-shirt).
- `policy.json`: `{"store":"Northwind Home","currency":"USD","return_window_days":30,"auto_approve_limit":75,"replacement_first_categories":["kitchen","lighting"],"non_returnable_categories":["apparel_worn"],"fraud":{"similarity_threshold":0.80,"action":"escalate"},"clauses":{"P1":"Refund window is 30 days from delivery","P2":"Damage must be visible in customer evidence","P3":"Amounts above $75 require human approval","P4":"Kitchen and lighting items: offer replacement first when in stock","P5":"Matching evidence across different accounts is escalated as suspected fraud","P6":"Worn apparel is not returnable"}}`.
- `demo_evidence.json`: placeholders to be filled with real `video_id`s after pre-indexing (see PLAYBOOK).
- `golden_claims.json`: 30 eval cases `{id, order_id, message, evidence_summary_stub, expected_action, expected_clauses, notes}` covering: clean auto-approve (10), above-limit escalate (5), outside window deny (4), replacement-first (4), fraud twin escalate (4), non-returnable (3).

## 6. Evaluation & monitoring (`eval/`, Python, AgentX)
- `eval/run_eval.py`: builds/reuses dataset "ClaimSight golden v1" from `golden_claims.json`; defines an LLM judge scorer with rubric "Did the agent choose the policy-correct action, cite the right clauses, never invent evidence, and keep the customer message clear?"; agent function POSTs each case to `${CLAIMSIGHT_URL}/claims` (non-stream mode: set `stream:false` in body → the agent returns JSON with the final text + decision) using conversation id `eval-<case id>`; `.execute(concurrency=3).finalize()`; `run.gate(fail_under=7.5, no_regression=True)`; prints a "Deploy Certificate" (pass rate, mean rating, min, cost/latency if available) and exits non-zero on failure.
- `eval/monitors.py`: enables built-in scorers `pii-in-response`, `secrets-in-response`, `prompt-injection`; publishes a semantic pattern "Response promises a refund without a transaction id" (severity high).
- `eval/README.md`: exact commands (`agentx-trace-eval --dev`, env vars).

## 7. WorkBuddy skill (`workbuddy/refund-desk/`)
`SKILL.md` (Trigger / Instructions / Example) + `config.yaml`. Instructions: call `GET {CLAIMSIGHT_URL}/claims?status=pending_review`, summarize each (order, amount, evidence line, fraud matches, agent recommendation), ask the manager approve/deny per claim, `POST /claims/decision`, then post a compact summary to the connected Slack channel. Include an Automation recipe: "Daily 9:00 — summarize yesterday's claims into a .docx: auto-approval rate, refunded $, fraud flags, top damage types."

## 8. VeloDB (optional, `velodb/`)
`schema.sql` (`claims_events` table: claim_id, order_id, customer_id, sku, action, amount, fraud_matches, latency_ms, decided_by, created_at; plus `evidence_captions` with a `VARIANT`/text column and an embedding column) and `load.py` (pymysql; pulls `GET /claims` and inserts) + `dashboard.sql` (auto-approval rate by hour, $ refunded, fraud clusters by matched video, p95 latency).

## 9. Env (`.env.example` — add to the template's)
`AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL=https://ai-gateway.edgeone.link/v1, AI_GATEWAY_MODEL=@makers/deepseek-v4-pro, MEMORIES_API_KEY, MEMORIES_BASE=https://api.memories.ai/serve/datalake/v1, MEMORIES_CLAIMS_COLLECTION, MEMORIES_CATALOG_COLLECTION, FRAUD_SIMILARITY_THRESHOLD=0.80, SELF_BASE_URL=http://localhost:8088, SLACK_WEBHOOK_URL, AGENTX_OTLP_URL, AGENTX_API_KEY, ADMIN_TOKEN, VELODB_HOST, VELODB_PORT=9030, VELODB_USER, VELODB_PASSWORD, VELODB_DB`.

## 10. Non-negotiables
- Secrets only in cloud functions / agent env; the model never sees API keys.
- Server-side policy enforcement in `/refund` (the agent cannot exceed limits even if prompted to).
- Every claim produces a decision record + an AgentX trace; the UI shows the trace.
- Everything must run locally with `edgeone makers dev` using the in-memory KV fallback and stubbed Memories.ai responses when `MEMORIES_API_KEY` is unset (`MEMORIES_STUB=1` returns canned summary/caption/search results from `data/stubs/`), so the whole flow can be rehearsed without network.
