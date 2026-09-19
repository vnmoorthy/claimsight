# ClaimSight evaluation & monitoring (AgentX)

The production-pipeline half of ClaimSight: a golden set of 30 claims, a CI gate that refuses
to "deploy" an agent that gets the policy wrong, and ingest-time monitors on live traffic.

```
data/golden_claims.json   30 cases (GC-01..GC-30): message, order, evidence stub, expected action + clauses
eval/run_eval.py          dataset -> run -> gate -> DEPLOY CERTIFICATE (exit 1 on failure)
eval/monitors.py          built-in scorers + "refund without txn id" patterns
eval/requirements.txt     agentx-python 0.8.28, requests, pymysql
```

Case mix: clean auto-approve ×10 (A1042 chipped mug, backordered → refund $24), above-limit
escalate ×5 (A1050/A1048 headphones $129, A1044 vase $85), outside-window deny ×4 (A1061 lamp
45 days, A1049 vase 40 days), replacement-first ×4 (A1045/A1051 lamps in stock), fraud-twin
escalate ×4 (A1043, same footage as A1042 from another account), non-returnable ×3 (A1077 and
A1047 worn t-shirts). Every case uses an order from `data/orders.json` and the stub video id
that `data/stubs/upload.json` maps to that order (`vid_stub_mug_alice`, `vid_stub_mug_mallory`,
...), so a run against the stubbed backend (`MEMORIES_STUB=1`) exercises the real decision path.
Each case also records `customer_id`, `sku`, `amount`, `delivered_days_ago` and `in_stock` as
pulled from the seed data, and `notes` explains the expected reasoning for the judge.

## 1. Install

```bash
cd claimsight
python3 -m venv .venv && source .venv/bin/activate
pip install -r eval/requirements.txt
```

## 2. Start the AgentX self-host server

```bash
# dev mode: local SQLite DB, opens the dashboard in your browser, API on port 4700
agentx-trace-eval --dev

# or pick a port (what the commands below assume)
agentx-trace-eval -port 4712
```

The first launch downloads the engine + dashboard into `~/.agentx/bin`. The startup log prints
what the SDK needs - copy both lines:

```
Default project API key: agtx_local_...
  AGENTX_API_BASE_URL=http://localhost:4712/api/v1
  AGENTX_API_KEY=agtx_local_...
```

Dashboard: <http://localhost:4712>. Data lives in `~/.agentx/agentx.db` (shared by every port).

**LLM judge key (real runs).** The judge runs *inside the server*, so its provider key goes on
the server process, not on the eval script:

```bash
OPENAI_API_KEY=sk-...   agentx-trace-eval -port 4712                 # default judge model gpt-5.6-luna
# or an Anthropic judge:
ANTHROPIC_API_KEY=sk-ant-... agentx-trace-eval -port 4712
export AGENTX_JUDGE_MODEL=claude-sonnet-4-5                          # any model id the key can reach
```

Without a key every judge row comes back `skipped` ("Judge model ... needs a OpenAI API key.
Set OPENAI_API_KEY and restart agentx-server") and the gate fails with "no rated results" -
use `--offline-scorer` (below) in that situation.

## 3. Environment

```bash
export AGENTX_API_BASE_URL=http://localhost:4712/api/v1   # from the startup log
export AGENTX_API_KEY=agtx_local_...                      # from the startup log
export CLAIMSIGHT_URL=http://localhost:8088               # backend (edgeone makers dev), default
# optional
export AGENTX_JUDGE_MODEL=gpt-5.6-luna                    # judge model id (LLM scorer)
export AGENTX_DASHBOARD_URL=http://localhost:4712         # only if the dashboard is not base_url minus /api/v1
export AGENTX_EVAL_QUIET=1                                # CI logs: no spinners / per-case lines
```

## 4. Dry run (no backend needed)

```bash
python eval/run_eval.py --dry-run --offline-scorer
```

`--dry-run` answers every case with a canned reply derived from `expected_action` (including the
fenced ```` ```decision ```` block and a believable tool ladder on the trace). `--offline-scorer`
grades with a deterministic code scorer that runs inside the engine - no LLM key anywhere.
Real output from this repo:

```
AgentX reachable at http://localhost:4712/api/v1
Loaded 30 golden cases from .../data/golden_claims.json
Dataset:
  created dataset OkV78FHHgw-A-6So-CUsC  "ClaimSight golden v1"  (30 cases)
Scorer:
  created code scorer fgw0VPLCwvlEpAZvJH-Cq  "ClaimSight policy-action match (offline)"
  created scorer group k59tAUufSYQ7knMifUasC  "ClaimSight offline gate v1"
Mode: dry-run (canned answers)
  AgentX Evaluation   -   ClaimSight golden v1
  Run   : ERXAF42NNF6O05Q53r_04
Executing  30 questions × 1 run
  ✓  [1/30] Q1 run #1  My mug arrived with a chip on the rim. I'd like a refun…  23ms
  ...
  ✓  Scored 10 results
  ✓  Finalized
  ✓  [fail-under] Average rating 10 >= floor 7.5
  ✓  [no-regression] No previous completed run with ratings on this dataset - nothing to regress against
  ✓  GATE PASSED
========================================================================
                        DEPLOY CERTIFICATE
========================================================================
  Result        : PASS - safe to deploy
  Mode          : dry-run (canned answers)
  Dataset       : ClaimSight golden v1  (OkV78FHHgw-A-6So-CUsC)
  Run id        : ERXAF42NNF6O05Q53r_04
  Scorer        : offline code scorer group "ClaimSight offline gate v1" (k59tAUufSYQ7knMifUasC) - action match, no LLM
  Cases         : 30   rated 30   skipped 0   failed 0
  Rating        : mean 10.00 / 10   min 10.00   max 10.00
  Gate          : fail_under=7.5  no_regression=True  (no baseline yet)
                  PASS [fail-under] Average rating 10 >= floor 7.5
                  PASS [no-regression] ...
  Latency       : mean 23 ms   p95 30 ms   (agent HTTP round-trip, 30 rows)
  Dashboard     : http://localhost:4712/governance?tab=evaluate   -> Evaluate -> Runs -> 'View details' on run ...
  Traces        : http://localhost:4712/governance?tab=observe    -> Observe -> Live Traces -> filter 'Eval runs'
========================================================================
```

See the gate reject something:

```bash
python eval/run_eval.py --dry-run --offline-scorer --inject-wrong 8   # 8 wrong answers -> mean 7.33
#   ✗  [fail-under] Average rating 7.33 < floor 7.5
#   ✗  [no-regression] Average rating 7.33 vs previous run's 10 (tolerance 0.5)
#   ✗  GATE FAILED            -> exit code 1
```

## 5. Real run against the backend

```bash
# terminal 1: backend (in-memory KV + MEMORIES_STUB=1 work without any external keys)
edgeone makers dev                      # -> http://localhost:8088
curl -X POST http://localhost:8088/seed # load data/orders.json + policy.json

# terminal 2: AgentX server with a judge key (section 2)

# terminal 3
python eval/run_eval.py                 # LLM judge, POSTs each case to $CLAIMSIGHT_URL/claims
python eval/run_eval.py --offline-scorer            # same calls, deterministic grading
python eval/run_eval.py --recreate-dataset          # after editing data/golden_claims.json
python eval/run_eval.py --certificate-json cert.json  # machine-readable copy of the certificate
```

What one case does: `POST {CLAIMSIGHT_URL}/claims` with header `Makers-Conversation-Id: eval-GC-07`
and body `{"message", "order_id", "evidence_video_id", "stream": false}`, expecting JSON
`{"text": "...", "decision": {...}}` (if the backend streams anyway, the body is parsed for the
```` ```decision ```` block). The call is wrapped in `client.tracer.trace(..., sync=True)` and the
result carries `trace_id`, so every row in the run links to its trace. Three cases run at a time.

Stub video ids: each case sends the `evidence_video_id` the backend's upload stub assigns to its
order (`data/stubs/upload.json` → `order_to_video`), so with `MEMORIES_STUB=1` the canned
summary / caption / search answers line up with the case: the fraud-twin cases (GC-24..27) send
`vid_stub_mug_mallory`, whose stub search returns `vid_stub_mug_alice` at 0.93, which
`data/stubs/video_index.json` resolves to customer `c_alice` → P5 escalation.

## 6. Reading the certificate

| Field | Meaning |
|-------|---------|
| Result | PASS only when the gate passed **and** no case errored |
| Cases / rated / skipped / failed | 30 golden cases; `skipped` = the judge could not score (no key); `failed` = the agent call raised (HTTP error, timeout) |
| Rating | server-computed mean/min/max on the 0-10 scale (judge rubric, or code score ×10) |
| Gate | `fail_under=7.5`: mean must be >= 7.5. `no_regression`: mean may not drop more than 0.5 below the dataset's previous completed run (the baseline run id is shown) |
| Latency | agent round-trip per case from the result rows |
| Tokens/cost | n/a for the HTTP agent; per-claim model cost is on the trace in Observe |
| Lowest rated | the three weakest cases with the judge's justification - start debugging there |
| Why | the reason for a FAIL that the gate alone would not show (errors, unrated rows) |

Exit code: `0` = PASS, `1` = FAIL, `2` = missing `AGENTX_API_KEY`. In CI:

```yaml
- run: pip install -r eval/requirements.txt
- run: AGENTX_EVAL_QUIET=1 python eval/run_eval.py --certificate-json cert.json
  env: { AGENTX_API_BASE_URL: ${{ vars.AGENTX_URL }}, AGENTX_API_KEY: ${{ secrets.AGENTX_KEY }}, CLAIMSIGHT_URL: ${{ vars.STAGING_URL }} }
```

## 7. Where to click in the dashboard (http://localhost:4712)

- **Evaluate → Runs** (`/governance?tab=evaluate`): one row per run with its rating; **View details**
  opens the run: every case with the question, the expected JSON (`expected_action`,
  `expected_clauses`, `evidence_summary`), the actual response, the score and a **View trace** link.
  **Analyze** produces the LLM report (needs a judge key).
- **Evaluate → CI Gates**: history of every `gate()` verdict (`caller=eval/run_eval.py`).
- **Evaluate → Datasets**: "ClaimSight golden v1" - the 30 cases; the six `smoke` cases (GC-01, 11,
  16, 20, 24, 28) are tagged for a quick split run.
- **Observe → Live Traces** (`/governance?tab=observe`): filter **Eval runs** to see the
  `claimsight-claims-agent` traces from the harness (tool ladder lookup_order → get_policy →
  inspect_evidence → fraud_check → execute/escalate → record_decision → POST /claims), or
  **Production** for what the backend's `/agentx-emit` sends per real claim. Eval traces are tagged
  `source=eval-run` and never count toward monitoring.
- **Monitor → Signals**: hits from the patterns below; **Scorers**: the built-in toggles.

## 8. Monitors

```bash
python eval/monitors.py            # enable built-ins + publish patterns (idempotent)
python eval/monitors.py --smoke    # also send a violating and a clean trace and list signals
```

Real output:

```
Built-in scorers (zero-LLM, checked on every ingested trace):
  ENABLED  pii-in-response              severity=high     kind=regex
  ENABLED  secrets-in-response          severity=critical kind=regex
  ENABLED  prompt-injection-echo        severity=high     kind=contains  (SPEC name 'prompt-injection' -> engine key 'prompt-injection-echo')

Monitor patterns:
  CREATED  semantic  severity=high    id=63KcbFgpZwMBm0i6iGsng  "Response promises a refund without a transaction id"
           evaluated by the judge LLM at ingest - needs OPENAI_API_KEY / ANTHROPIC_API_KEY on the server
  CREATED  contains  severity=high    id=RmcUeS9xQ1M-aPdlIkV8S  "Refund promised without txn id (keyword backstop)"
           zero-LLM: any of 16 refund-issued phrases and none of ['txn_', 'rpl_', 'transaction', 'reference']
```

Notes: the engine ships the prompt-injection detector under the key `prompt-injection-echo`
(resolved by prefix, so the SPEC name still works). The semantic pattern is judged by an LLM at
ingest and stays silent without a server-side key; the keyword backstop fires without one (the
engine validates regexes with Go RE2 - no lookahead - hence include/exclude terms instead of a
regex). `--smoke` showed the backstop raising a high-severity signal on the violating trace and
nothing on the clean one.

## 9. Troubleshooting

- `Cannot reach AgentX at ...` - server not running or wrong port; `AGENTX_API_BASE_URL` must end in `/api/v1`.
- `rejected the API key (HTTP 401)` - the key changes when `~/.agentx/agentx.db` is recreated; copy it from the current startup log.
- All rows `skipped`, gate "no rated results" - no judge key on the server; restart it with `OPENAI_API_KEY` or use `--offline-scorer`.
- `failed N` in the certificate - the backend returned an HTTP error or timed out (`--timeout`, default 240 s per case); the first error message is printed under "Failed rows".
- Dataset "does not match golden_claims.json" - re-run with `--recreate-dataset`.
- Port already in use - `agentx-trace-eval -port 4713` and update `AGENTX_API_BASE_URL`.
