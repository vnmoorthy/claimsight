#!/usr/bin/env python3
"""ClaimSight golden evaluation -> AgentX CI gate -> Deploy Certificate.

What it does (SPEC section 6):
  1. Creates or reuses the AgentX dataset "ClaimSight golden v1" from data/golden_claims.json
     (30 cases; the case id rides inside each query so results map back to the golden case).
  2. Grades with an LLM judge scorer carrying the policy rubric ("Did the agent choose the
     policy-correct action, cite the right clauses, never invent evidence, and keep the
     customer message clear?"), or - with --offline-scorer - a deterministic in-engine code
     scorer that compares decision.action to expected_action (no LLM key needed).
  3. The agent function POSTs each case to  {CLAIMSIGHT_URL}/claims  with
     {"message", "order_id", "evidence_video_id", "stream": false} and header
     Makers-Conversation-Id: eval-<case id>, expecting JSON {"text", "decision"}.
     Every call is wrapped in client.tracer.trace(..., sync=True) and the resulting
     trace_id is attached to the evaluation result (visible in Observe -> Live Traces).
  4. .execute(concurrency=3) -> .finalize() -> .gate(fail_under=7.5, no_regression=True)
  5. Prints a DEPLOY CERTIFICATE and exits non-zero when the gate fails.

Flags:
  --dry-run          skip the HTTP call; return a canned answer derived from expected_action
                     (lets you test the harness before the backend exists)
  --offline-scorer   grade with the code scorer instead of the LLM judge
  --inject-wrong N   (dry-run only) answer the first N cases with a wrong action, to demo a
                     failing gate
  --recreate-dataset delete and rebuild the dataset from golden_claims.json (after edits)

Environment:
  AGENTX_API_BASE_URL   e.g. http://localhost:4712/api/v1   (printed by agentx-trace-eval)
  AGENTX_API_KEY        the "Default project API key" from the agentx-trace-eval startup log
  CLAIMSIGHT_URL        base URL of the ClaimSight backend (default http://localhost:8088)
  AGENTX_JUDGE_MODEL    judge model id for the LLM scorer (default: engine default,
                        currently "gpt-5.6-luna"). The KEY for the judge lives on the AgentX
                        *server*: start agentx-trace-eval with OPENAI_API_KEY (OpenAI judge ids)
                        or ANTHROPIC_API_KEY (claude-* judge ids) exported. Without a key every
                        judge row is "skipped" and the gate fails with "no rated results" -
                        use --offline-scorer in that situation.
  AGENTX_DASHBOARD_URL  override for the dashboard link in the certificate
                        (default: AGENTX_API_BASE_URL with /api/v1 stripped)

SDK surfaces used (agentx-python 0.8.28):
  AgentX.from_env(), client.ping()
  client.evaluations.datasets.list() / .builder(...).add_case(...).publish() / .delete()
  client.monitor.judge_scorers.list() / .builder(...).publish() / .update()
  client.monitor.scorers.list() / .create_code() / .update()
  client.monitor.scorer_groups.list() / .create() / .update()
  client.evaluations.run(dataset_id, subject, scorer_id=... | scorer_group_id=...)
      .execute(agent_fn, concurrency=3).finalize().gate(fail_under=7.5, no_regression=True)
  ctx.results() / ctx.average_rating / ctx.min_rating / ctx.rated_count / ...
  client.tracer.trace(name, input=..., metadata=..., sync=True, framework=..., span_kind="agent")
      span.add_tool_call(...), span.output, span.trace_id
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import textwrap
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    from agentx import AgentX
except ImportError:  # pragma: no cover
    print("agentx-python is not installed - pip install -r eval/requirements.txt", file=sys.stderr)
    raise

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
GOLDEN_PATH = ROOT / "data" / "golden_claims.json"

DATASET_NAME = "ClaimSight golden v1"
JUDGE_SCORER_NAME = "ClaimSight policy judge v1"
CODE_SCORER_NAME = "ClaimSight policy-action match (offline)"
SCORER_GROUP_NAME = "ClaimSight offline gate v1"
AGENT_TRACE_NAME = "claimsight-claims-agent"

ACTIONS = ("refund", "replacement", "escalated", "denied", "needs_info")

POLICY_CLAUSES = {
    "P1": "Refund window is 30 days from delivery",
    "P2": "Damage must be visible in customer evidence",
    "P3": "Amounts above $75 require human approval",
    "P4": "Kitchen and lighting items: offer replacement first when in stock",
    "P5": "Matching evidence across different accounts is escalated as suspected fraud",
    "P6": "Worn apparel is not returnable",
}

# ---------------------------------------------------------------------------
# Judge rubric (SPEC section 6)
# ---------------------------------------------------------------------------
RUBRIC_EVALUATION = (
    "Did the agent choose the policy-correct action, cite the right clauses, never invent "
    "evidence, and keep the customer message clear? Score 0-10. The expected answer is a JSON "
    "object with expected_action, expected_clauses, evidence_summary and notes. Weight: action "
    "correctness 50%, clause citation 20%, evidence fidelity 20%, clarity 10%. A wrong action "
    "caps the score at 3. Policy: P1 30-day window from delivery; P2 damage must be visible in "
    "evidence; P3 amounts above $75 need human approval; P4 kitchen/lighting items get a "
    "replacement first when in stock; P5 matching evidence across accounts is escalated as "
    "suspected fraud; P6 worn apparel is not returnable."
)
RUBRIC_ACCEPTANCE = (
    "The final message ends with a fenced ```decision block whose action equals "
    "expected_action; policy_clauses include the clauses in expected_clauses; the evidence line "
    "only restates what the evidence summary contains; refund/replacement decisions carry a "
    "txn_id, escalated/denied decisions carry none and move no money; the customer-facing text "
    "is plain, specific, and states what happens next."
)
RUBRIC_REJECTION = (
    "Wrong action (e.g. a refund where policy requires escalation or denial); refunding more "
    "than $75 without human approval; refunding worn apparel or an order outside the 30-day "
    "window; approving a claim whose evidence matches another customer's clip; describing "
    "damage that is not in the evidence summary; promising a refund without a transaction id; "
    "missing or malformed decision block; invented tool results."
)

# ---------------------------------------------------------------------------
# Offline (code) scorer - runs INSIDE the AgentX engine, per result. Deterministic, no LLM.
# handler(input, output, expected, metadata, trace) -> 0..1 score dict, or None to skip.
# Arguments are accepted as str or dict because the wire shape is the engine's business.
# ---------------------------------------------------------------------------
CODE_SCORER_SCRIPT = textwrap.dedent(
    r'''
    import json, re

    ACTIONS = ("refund", "replacement", "escalated", "denied")

    def _text(v):
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            for k in ("text", "output", "response", "expectedResults", "expected_results"):
                if isinstance(v.get(k), str):
                    return v[k]
            return json.dumps(v, default=str)
        return str(v)

    def _expected(expected, metadata):
        meta = metadata if isinstance(metadata, dict) else {}
        if isinstance(meta.get("expected_action"), str):
            return meta["expected_action"].lower(), meta
        s = _text(expected)
        try:
            d = json.loads(s)
            if isinstance(d, dict) and d.get("expected_action"):
                return str(d["expected_action"]).lower(), d
        except Exception:
            pass
        m = re.search(r"expected_action\W+(refund|replacement|escalated|denied|needs_info)", s, re.I)
        return (m.group(1).lower() if m else ""), {}

    def _decision(out_text):
        m = re.search(r"```decision\s*(\{.*?\})\s*```", out_text, re.S)
        if m:
            try:
                d = json.loads(m.group(1))
                a = str(d.get("action", "")).lower()
                if a in ACTIONS:
                    return a, d
            except Exception:
                pass
        low = out_text.lower()
        for a in ("escalated", "replacement", "denied", "refund"):
            if a in low or (a == "escalated" and "escalat" in low) or (a == "denied" and "not eligible" in low):
                return a, {}
        return "", {}

    def handler(input, output, expected, metadata, trace):
        exp_action, exp = _expected(expected, metadata)
        if exp_action not in ACTIONS:
            return None  # not a golden case (e.g. sampled live traffic) - skip
        out_text = _text(output)
        got, dec = _decision(out_text)
        score = 1.0 if got == exp_action else 0.0
        notes = ["expected=%s" % exp_action, "got=%s" % (got or "none")]
        txn = dec.get("txn_id") if isinstance(dec, dict) else None
        if score == 1.0 and got in ("refund", "replacement") and not txn:
            score = 0.5
            notes.append("missing txn_id for a money-moving action")
        if got in ("escalated", "denied") and txn:
            score = 0.0
            notes.append("txn_id present on a non-paying action")
        want = exp.get("expected_clauses") if isinstance(exp, dict) else None
        cited = dec.get("policy_clauses") if isinstance(dec, dict) else None
        if isinstance(want, list) and isinstance(cited, list):
            missing = [c for c in want if c not in cited]
            notes.append("clauses missing=%s" % (missing or "none"))
        return {"score": score, "name": "policy-action-match", "reasoning": "; ".join(notes)}
    '''
).strip() + "\n"


# ---------------------------------------------------------------------------
# Golden cases
# ---------------------------------------------------------------------------
def load_golden(path: Path) -> List[Dict[str, Any]]:
    cases = json.loads(path.read_text())
    if not isinstance(cases, list) or not cases:
        raise SystemExit(f"{path}: expected a non-empty JSON array of cases")
    for c in cases:
        for key in ("id", "order_id", "message", "evidence_summary_stub", "expected_action", "expected_clauses"):
            if key not in c:
                raise SystemExit(f"{path}: case {c.get('id')!r} is missing {key!r}")
        if c["expected_action"] not in ACTIONS:
            raise SystemExit(f"{path}: case {c['id']} has unknown expected_action {c['expected_action']!r}")
        c.setdefault("evidence_video_id", f"stub-{c['id'].lower()}")
    return cases


CASE_TAG_RE = re.compile(r"\[case=(GC-\d+)")


def query_for(case: Dict[str, Any]) -> str:
    """The dataset query: the customer message plus a trailer that carries the case id, order id
    and stub video id so the agent function can map the engine's EvaluationCase back to the
    golden case (and so a reviewer reading the run sees the context)."""
    return (
        f"{case['message']}\n\n"
        f"[case={case['id']}; order_id={case['order_id']}; evidence_video_id={case['evidence_video_id']}]"
    )


def expected_for(case: Dict[str, Any]) -> str:
    return json.dumps(
        {
            "expected_action": case["expected_action"],
            "expected_clauses": case["expected_clauses"],
            "order_id": case["order_id"],
            "sku": case.get("sku"),
            "amount": case.get("amount"),
            "evidence_summary": case["evidence_summary_stub"],
            "notes": case.get("notes", ""),
        }
    )


# ---------------------------------------------------------------------------
# Dataset create-or-reuse
# ---------------------------------------------------------------------------
def find_dataset(client: AgentX, name: str):
    matches = [d for d in client.evaluations.datasets.list() if d.name == name]
    return matches[0] if matches else None


def ensure_dataset(client: AgentX, cases: List[Dict[str, Any]], recreate: bool):
    existing = find_dataset(client, DATASET_NAME)
    if existing and recreate:
        print(f"  deleting dataset {existing.id} ({DATASET_NAME}) for rebuild")
        client.evaluations.datasets.delete(existing.id)
        existing = None
    if existing:
        ids_in_dataset = {
            (CASE_TAG_RE.search(q.main_question.query) or [None, None])[1]
            for q in existing.questions
        }
        wanted = {c["id"] for c in cases}
        if ids_in_dataset != wanted:
            print(
                f"  WARNING: dataset {existing.id} has {len(existing.questions)} cases that do not match "
                f"golden_claims.json ({len(wanted)} cases). Re-run with --recreate-dataset."
            )
        print(f"  reusing dataset {existing.id}  \"{DATASET_NAME}\"  ({len(existing.questions)} cases)")
        return existing
    builder = client.evaluations.datasets.builder(
        DATASET_NAME,
        description=(
            "ClaimSight golden claims: clean auto-approve (10), above-limit escalate (5), outside-window "
            "deny (4), replacement-first (4), fraud-twin escalate (4), non-returnable (3). Built from "
            "data/golden_claims.json by eval/run_eval.py."
        ),
        number_of_requests=1,
        acceptance_criteria=RUBRIC_ACCEPTANCE,
        rejection_criteria=RUBRIC_REJECTION,
        evaluation_criteria=RUBRIC_EVALUATION,
    )
    for c in cases:
        builder.add_case(
            query=query_for(c),
            expected_results=expected_for(c),
            judge_guideline=f"{c['id']} ({c.get('category', 'n/a')}): {c.get('notes', '')}",
            splits=["smoke"] if c["id"] in ("GC-01", "GC-11", "GC-16", "GC-20", "GC-24", "GC-28") else None,
        )
    ds = builder.publish()
    print(f"  created dataset {ds.id}  \"{DATASET_NAME}\"  ({len(ds.questions)} cases)")
    return ds


# ---------------------------------------------------------------------------
# Scorers create-or-reuse
# ---------------------------------------------------------------------------
def ensure_judge_scorer(client: AgentX, judge_model: Optional[str]):
    desired = {
        "acceptanceCriteria": RUBRIC_ACCEPTANCE,
        "rejectionCriteria": RUBRIC_REJECTION,
        "evaluationCriteria": RUBRIC_EVALUATION,
    }
    if judge_model:
        desired["judgeModel"] = judge_model
    existing = [s for s in client.monitor.judge_scorers.list() if s.name == JUDGE_SCORER_NAME]
    if existing:
        scorer = existing[0]
        stored = scorer.judge or {}
        if any(stored.get(k) != v for k, v in desired.items()):
            scorer = client.monitor.judge_scorers.update(scorer.id, judge={**stored, **desired})
            print(f"  updated judge scorer {scorer.id}  \"{JUDGE_SCORER_NAME}\" (rubric changed)")
        else:
            print(f"  reusing judge scorer {scorer.id}  \"{JUDGE_SCORER_NAME}\"")
        return scorer
    scorer = client.monitor.judge_scorers.builder(
        JUDGE_SCORER_NAME,
        description="LLM judge for the ClaimSight golden set - policy-correct action, clauses, evidence fidelity, clarity.",
        acceptance_criteria=RUBRIC_ACCEPTANCE,
        rejection_criteria=RUBRIC_REJECTION,
        evaluation_criteria=RUBRIC_EVALUATION,
        judge_model=judge_model,
        number_of_requests=1,
    ).publish()
    print(f"  created judge scorer {scorer.id}  \"{JUDGE_SCORER_NAME}\"" + (f" (model {judge_model})" if judge_model else ""))
    return scorer


def ensure_offline_scorer_group(client: AgentX):
    code = [e for e in client.monitor.scorers.list() if e.get("name") == CODE_SCORER_NAME and e.get("kind") == "code"]
    if code:
        scorer = code[0]
        if scorer.get("script") != CODE_SCORER_SCRIPT:
            scorer = client.monitor.scorers.update(scorer["_id"], script=CODE_SCORER_SCRIPT, language="python")
            print(f"  updated code scorer {scorer['_id']}  \"{CODE_SCORER_NAME}\" (script changed)")
        else:
            print(f"  reusing code scorer {scorer['_id']}  \"{CODE_SCORER_NAME}\"")
    else:
        scorer = client.monitor.scorers.create_code(
            CODE_SCORER_NAME,
            CODE_SCORER_SCRIPT,
            language="python",
            alert_below=0.5,
            sample_rate=0.05,  # live traffic has no expected_action -> handler returns None (skip)
            severity="high",
        )
        print(f"  created code scorer {scorer['_id']}  \"{CODE_SCORER_NAME}\"")
    members = [{"kind": "custom", "refId": scorer["_id"], "weight": 1, "gate": False}]
    groups = [g for g in client.monitor.scorer_groups.list() if g.name == SCORER_GROUP_NAME]
    if groups:
        group = groups[0]
        if [(m.get("kind"), m.get("refId")) for m in group.members] != [("custom", scorer["_id"])]:
            group = client.monitor.scorer_groups.update(group.id, members=members)
            print(f"  updated scorer group {group.id}  \"{SCORER_GROUP_NAME}\"")
        else:
            print(f"  reusing scorer group {group.id}  \"{SCORER_GROUP_NAME}\"")
    else:
        group = client.monitor.scorer_groups.create(
            SCORER_GROUP_NAME,
            members=members,
            description="Deterministic gate: decision.action == expected_action (+ txn_id invariants). No LLM.",
        )
        print(f"  created scorer group {group.id}  \"{SCORER_GROUP_NAME}\"")
    return group


# ---------------------------------------------------------------------------
# Canned answers for --dry-run
# ---------------------------------------------------------------------------
def canned_answer(case: Dict[str, Any], action: str) -> Tuple[str, Dict[str, Any]]:
    order = case["order_id"]
    amount = float(case.get("amount") or 0.0)
    clauses = list(case.get("expected_clauses") or [])
    evidence = case["evidence_summary_stub"]
    claim_id = f"clm_dry_{case['id'].lower().replace('-', '')}"
    txn_id: Optional[str] = None
    fraud_matches = 1 if case.get("category") == "fraud_twin_escalate" else 0
    cited = ", ".join(f"{c} ({POLICY_CLAUSES.get(c, '')})" for c in clauses) or "our returns policy"
    if action == "refund":
        txn_id = f"txn_dry_{case['id'].lower().replace('-', '')}"
        prose = (
            f"Thanks for the video. I reviewed the evidence for order {order}: {evidence} "
            f"That is covered by {cited}, so I have issued a refund of ${amount:.2f} to your original "
            f"payment method (transaction {txn_id}). Please allow 3-5 business days for it to appear."
        )
        paid = amount
    elif action == "replacement":
        txn_id = f"rpl_dry_{case['id'].lower().replace('-', '')}"
        prose = (
            f"Thanks for the video. I reviewed the evidence for order {order}: {evidence} "
            f"Under {cited} we replace kitchen items first when they are in stock, so a replacement "
            f"{case.get('sku', 'item')} is on its way at no charge (reference {txn_id}). No need to return the damaged one."
        )
        paid = 0.0
    elif action == "escalated":
        reason = "the amount is above our automatic approval limit" if "P3" in clauses else (
            "the evidence matches a clip submitted from another account" if "P5" in clauses else "this needs a human review")
        prose = (
            f"Thanks for the video. I reviewed the evidence for order {order}: {evidence} "
            f"Because {reason} ({cited}), I have passed this to a human reviewer. You will hear back within one business day; "
            f"nothing has been charged or refunded yet."
        )
        paid = 0.0
    else:  # denied
        reason = "it was delivered more than 30 days ago" if "P1" in clauses else (
            "worn apparel is not returnable" if "P6" in clauses else "it is not covered by policy")
        prose = (
            f"Thanks for the video. I reviewed the evidence for order {order}: {evidence} "
            f"Unfortunately this claim is not eligible because {reason} ({cited}), so no refund has been issued. "
            f"If you think we have this wrong, reply here and a teammate will take a second look."
        )
        paid = 0.0
    block = {
        "claim_id": claim_id,
        "action": action,
        "amount": paid,
        "policy_clauses": clauses,
        "evidence": evidence[:140],
        "fraud_matches": fraud_matches,
        "txn_id": txn_id,
        "latency_ms": 42,
    }
    text = prose + "\n\n```decision\n" + json.dumps(block) + "\n```"
    return text, block


DECISION_BLOCK_RE = re.compile(r"```decision\s*(\{.*?\})\s*```", re.S)


def parse_decision(text: str) -> Optional[Dict[str, Any]]:
    m = DECISION_BLOCK_RE.search(text or "")
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------------------
# The agent function handed to .execute()
# ---------------------------------------------------------------------------
def make_agent(client: AgentX, by_id: Dict[str, Dict[str, Any]], args: argparse.Namespace):
    wrong_for: Dict[str, str] = {}
    if args.dry_run and args.inject_wrong > 0:
        for case in list(by_id.values())[: args.inject_wrong]:
            others = [a for a in ACTIONS if a != case["expected_action"]]
            wrong_for[case["id"]] = others[0]

    def agent(evaluation_case):
        m = CASE_TAG_RE.search(evaluation_case.query or "")
        if not m or m.group(1) not in by_id:
            raise RuntimeError(f"cannot map dataset query to a golden case: {evaluation_case.query[:80]!r}")
        case = by_id[m.group(1)]
        cid = case["id"]
        body = {
            "message": case["message"],
            "order_id": case["order_id"],
            "evidence_video_id": case["evidence_video_id"],
            "stream": False,
        }
        # x-claimsight-eval: evaluations never trigger a Damage Twin render (twin.status "skipped").
        headers = {"Content-Type": "application/json", "Makers-Conversation-Id": f"eval-{cid}", "x-claimsight-eval": "1"}
        with client.tracer.trace(
            AGENT_TRACE_NAME,
            input={"conversation_id": f"eval-{cid}", **body},
            metadata={
                "case_id": cid,
                "category": case.get("category"),
                "expected_action": case["expected_action"],
                "expected_clauses": case["expected_clauses"],
                "mode": "dry-run" if args.dry_run else "http",
            },
            framework="edgeone-makers",
            span_kind="agent",
            session_id=f"eval-{cid}",
            sync=True,
        ) as span:
            started = time.monotonic()
            if args.dry_run:
                action = wrong_for.get(cid, case["expected_action"])
                text, decision = canned_answer(case, action)
                # A believable tool ladder so the trace tree looks like the real agent's.
                span.add_tool_call("lookup_order", input={"order_id": case["order_id"]}, output={"found": True, "sku": case.get("sku")}, latency_ms=3)
                span.add_tool_call("get_policy", input={}, output={"return_window_days": 30, "auto_approve_limit": 75}, latency_ms=2)
                span.add_tool_call("inspect_evidence", input={"video_id": case["evidence_video_id"]}, output={"description": case["evidence_summary_stub"]}, latency_ms=9)
                span.add_tool_call("fraud_check", input={"video_id": case["evidence_video_id"], "order_id": case["order_id"]}, output={"is_suspicious": decision["fraud_matches"] > 0, "matches": decision["fraud_matches"]}, latency_ms=7)
                if action in ("refund", "replacement"):
                    span.add_tool_call("execute_refund" if action == "refund" else "create_replacement", input={"order_id": case["order_id"], "amount": decision["amount"]}, output={"txn_id": decision["txn_id"]}, latency_ms=5)
                elif action == "escalated":
                    span.add_tool_call("escalate", input={"claim_id": decision["claim_id"]}, output={"status": "pending_review"}, latency_ms=4)
                span.add_tool_call("record_decision", input={"claim_id": decision["claim_id"], "action": action}, output={"ok": True}, latency_ms=2)
                status_code = 200
            else:
                url = f"{args.claimsight_url.rstrip('/')}/claims"
                if getattr(args, "reset_per_case", False):
                    # Golden cases share orders (A1042 appears in several), and a refund that already
                    # hit the ledger would turn the next "refund" case into an escalation. Start each
                    # case from a freshly seeded store (memory backend: ~50 ms).
                    seed_headers = {"Content-Type": "application/json"}
                    if os.getenv("ADMIN_TOKEN"):
                        seed_headers["x-admin-token"] = os.environ["ADMIN_TOKEN"]
                    seed = requests.post(f"{args.claimsight_url.rstrip('/')}/seed", headers=seed_headers, json={}, timeout=args.timeout)
                    if seed.status_code >= 400:
                        raise RuntimeError(f"POST /seed -> HTTP {seed.status_code}: {seed.text[:200]}")
                resp = requests.post(url, headers=headers, json=body, timeout=args.timeout)
                status_code = resp.status_code
                ctype = resp.headers.get("content-type", "")
                if resp.status_code >= 400:
                    raise RuntimeError(f"POST {url} -> HTTP {resp.status_code}: {resp.text[:300]}")
                if "json" in ctype:
                    data = resp.json()
                    text = data.get("text") or data.get("reply") or data.get("output") or data.get("message") or ""
                    decision = data.get("decision") or parse_decision(text)
                else:  # the backend streamed anyway - fall back to the raw body
                    text = resp.text
                    decision = parse_decision(text)
                if not text:
                    raise RuntimeError(f"POST {url} returned no text (content-type {ctype})")
            latency_ms = int((time.monotonic() - started) * 1000)
            span.add_tool_call(
                "POST /claims",
                input={"url": None if args.dry_run else f"{args.claimsight_url.rstrip('/')}/claims", "conversation_id": f"eval-{cid}", "order_id": case["order_id"]},
                output={"status": status_code, "decision": decision},
                latency_ms=latency_ms,
            )
            span.output = {"text": text, "decision": decision}
        return {
            "output": text,
            "trace_id": span.trace_id,
            "metadata": {
                "case_id": cid,
                "category": case.get("category"),
                "expected_action": case["expected_action"],
                "expected_clauses": case["expected_clauses"],
                "decision": decision,
                "latency_ms": latency_ms,
            },
        }

    return agent


# ---------------------------------------------------------------------------
# Certificate
# ---------------------------------------------------------------------------
def dashboard_base(client: AgentX) -> str:
    override = os.getenv("AGENTX_DASHBOARD_URL")
    if override:
        return override.rstrip("/")
    base = (client.base_url or "http://localhost:4700/api/v1").rstrip("/")
    return re.sub(r"/api/v\d+$", "", base)


def print_certificate(
    *,
    passed: bool,
    dataset,
    ctx,
    gate,
    scorer_label: str,
    rows: list,
    case_count: int,
    dash: str,
    mode: str,
    reason: Optional[str] = None,
) -> Dict[str, Any]:
    latencies = [r.latency_ms for r in rows if r.latency_ms is not None]
    ratings = [r.rating for r in rows if r.rating is not None]
    mean = ctx.average_rating if ctx.average_rating is not None else (statistics.fmean(ratings) if ratings else None)
    lo = ctx.min_rating if ctx.min_rating is not None else (min(ratings) if ratings else None)
    hi = ctx.max_rating if ctx.max_rating is not None else (max(ratings) if ratings else None)
    p95 = None
    if latencies:
        s = sorted(latencies)
        p95 = s[min(len(s) - 1, int(round(0.95 * len(s))) - 1) if len(s) > 1 else 0]
    in_tok = sum(r.input_tokens or 0 for r in rows)
    out_tok = sum(r.output_tokens or 0 for r in rows)
    failed_rows = [r for r in rows if r.status == "failed"]
    low_rows = sorted([r for r in rows if r.rating is not None], key=lambda r: r.rating)[:3]

    def fmt(x: Optional[float]) -> str:
        return "n/a" if x is None else f"{x:.2f}"

    checks = []
    for chk in gate.checks:
        checks.append(f"{'PASS' if chk.get('passed') else 'FAIL'} [{chk.get('check')}] {chk.get('detail')}")
    lines = [
        "",
        "=" * 72,
        "                        DEPLOY CERTIFICATE",
        "=" * 72,
        f"  Result        : {'PASS - safe to deploy' if passed else 'FAIL - do not deploy'}",
        f"  Mode          : {mode}",
        f"  Dataset       : {dataset.name}  ({dataset.id})",
        f"  Run id        : {ctx.run_id}",
        f"  Scorer        : {scorer_label}",
        f"  Cases         : {case_count}   rated {ctx.rated_count}   skipped {ctx.skipped_count}   failed {ctx.failed_count}",
        f"  Rating        : mean {fmt(mean)} / 10   min {fmt(lo)}   max {fmt(hi)}",
        f"  Gate          : fail_under=7.5  no_regression=True"
        + (f"  (baseline {fmt(gate.baseline_average)} from run {gate.baseline_run_id})" if gate.baseline_run_id else "  (no baseline yet)"),
    ]
    for c in checks:
        lines.append(f"                  {c}")
    lines.append(
        f"  Latency       : mean {int(statistics.fmean(latencies))} ms   p95 {int(p95)} ms   (agent HTTP round-trip, {len(latencies)} rows)"
        if latencies
        else "  Latency       : n/a"
    )
    lines.append(
        f"  Tokens/cost   : {in_tok} in / {out_tok} out (from result rows)" if (in_tok or out_tok)
        else "  Tokens/cost   : n/a - the HTTP agent does not report tokens; per-claim cost is on the trace in Observe"
    )
    if reason:
        lines.append(f"  Why           : {reason}")
    if failed_rows:
        lines.append(f"  Failed rows   : {len(failed_rows)} - first: {(failed_rows[0].raw.get('error') or {}).get('message', '')!s:.120}")
    if low_rows:
        lines.append("  Lowest rated  :")
        for r in low_rows:
            m = CASE_TAG_RE.search(r.question_text or "")
            lines.append(f"                  {m.group(1) if m else '?':6} {fmt(r.rating):>5}  {(r.justification or '')[:90]}")
    lines += [
        f"  Dashboard     : {dash}/governance?tab=evaluate   -> Evaluate -> Runs -> 'View details' on run {ctx.run_id}",
        f"  CI history    : {dash}/governance?tab=evaluate   -> Evaluate -> CI Gates",
        f"  Traces        : {dash}/governance?tab=observe    -> Observe -> Live Traces -> filter 'Eval runs', agent \"{AGENT_TRACE_NAME}\"",
        "=" * 72,
        "",
    ]
    print("\n".join(lines))
    return {
        "passed": passed,
        "mode": mode,
        "dataset_id": dataset.id,
        "dataset_name": dataset.name,
        "run_id": ctx.run_id,
        "scorer": scorer_label,
        "cases": case_count,
        "rated": ctx.rated_count,
        "skipped": ctx.skipped_count,
        "failed": ctx.failed_count,
        "mean_rating": mean,
        "min_rating": lo,
        "max_rating": hi,
        "gate": gate.raw,
        "latency_ms": {"mean": int(statistics.fmean(latencies)) if latencies else None, "p95": int(p95) if p95 is not None else None},
        "dashboard": f"{dash}/governance?tab=evaluate",
        "traces": f"{dash}/governance?tab=observe",
        "reason": reason,
    }


# ---------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="skip the HTTP call; canned answer from expected_action")
    ap.add_argument("--offline-scorer", action="store_true", help="grade with the deterministic code scorer (no LLM key)")
    ap.add_argument("--inject-wrong", type=int, default=0, metavar="N", help="dry-run: answer the first N cases wrongly (demo a failing gate)")
    ap.add_argument("--recreate-dataset", action="store_true", help="delete and rebuild the dataset from golden_claims.json")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--reset-per-case", dest="reset_per_case", action=argparse.BooleanOptionalAction, default=True,
                    help="POST /seed before every live case so orders shared between cases start from a clean ledger (forces --concurrency 1)")
    ap.add_argument("--timeout", type=float, default=240.0, help="seconds per POST /claims")
    ap.add_argument("--golden", default=str(GOLDEN_PATH), help="path to golden_claims.json")
    ap.add_argument("--claimsight-url", default=os.getenv("CLAIMSIGHT_URL", "http://localhost:8088"))
    ap.add_argument("--judge-model", default=os.getenv("AGENTX_JUDGE_MODEL") or None, help="judge model id (LLM scorer)")
    ap.add_argument("--certificate-json", default=None, help="also write the certificate as JSON to this path")
    ap.add_argument("--display-name", default="ClaimSight claims agent")
    args = ap.parse_args(argv)

    if not os.getenv("AGENTX_API_KEY"):
        print("AGENTX_API_KEY is not set - copy the 'Default project API key' from the agentx-trace-eval startup log.", file=sys.stderr)
        return 2
    if not (os.getenv("AGENTX_API_BASE_URL") or os.getenv("AGENTX_SELFHOST_BASE_URL") or os.getenv("BASE_URL")):
        os.environ["AGENTX_API_BASE_URL"] = "http://localhost:4712/api/v1"
        print("AGENTX_API_BASE_URL not set - defaulting to http://localhost:4712/api/v1")

    client = AgentX.from_env()
    ping = client.ping()
    print(f"AgentX reachable at {ping['base_url']}")

    cases = load_golden(Path(args.golden))
    by_id = {c["id"]: c for c in cases}
    print(f"Loaded {len(cases)} golden cases from {args.golden}")

    print("Dataset:")
    dataset = ensure_dataset(client, cases, recreate=args.recreate_dataset)

    print("Scorer:")
    run_kwargs: Dict[str, Any] = {}
    if args.offline_scorer:
        group = ensure_offline_scorer_group(client)
        run_kwargs["scorer_group_id"] = group.id
        scorer_label = f"offline code scorer group \"{SCORER_GROUP_NAME}\" ({group.id}) - action match, no LLM"
    else:
        judge = ensure_judge_scorer(client, args.judge_model)
        run_kwargs["scorer_id"] = judge.id
        model = (judge.judge or {}).get("judgeModel") or "engine default"
        scorer_label = f"LLM judge \"{JUDGE_SCORER_NAME}\" ({judge.id}), model {model}"
        print("  note: the judge's provider key must be set on the agentx-trace-eval SERVER process "
              "(OPENAI_API_KEY or ANTHROPIC_API_KEY); otherwise rows come back 'skipped'. Use --offline-scorer to gate without a key.")

    mode = ("dry-run (canned answers)" if args.dry_run else f"live -> POST {args.claimsight_url.rstrip('/')}/claims") + (
        f", {args.inject_wrong} answers deliberately wrong" if args.dry_run and args.inject_wrong else "")
    print(f"Mode: {mode}")

    subject = {
        "kind": "custom_agent",
        "displayName": args.display_name,
        "framework": "edgeone-makers",
        "runtime": "local",
        "metadata": {"mode": "dry-run" if args.dry_run else "http", "claimsight_url": args.claimsight_url},
    }
    ctx = client.evaluations.run(dataset.id, subject, **run_kwargs)
    if args.reset_per_case and not args.dry_run and args.concurrency != 1:
        print("  reset-per-case is on: running cases sequentially (concurrency 1)")
        args.concurrency = 1
    ctx = ctx.execute(make_agent(client, by_id, args), concurrency=args.concurrency).finalize()
    gate = ctx.gate(fail_under=7.5, no_regression=True, caller="eval/run_eval.py")

    rows = ctx.results()
    reason = None
    passed = bool(gate.passed)
    if ctx.failed_count:
        passed = False
        reason = f"{ctx.failed_count} case(s) errored (agent call failed) - see 'Failed rows'"
    elif ctx.rated_count == 0:
        passed = False
        first = next((r.justification for r in rows if r.justification), "")
        reason = f"no rated results - {first[:160]}" if first else "no rated results"
    elif ctx.rated_count < len(cases):
        reason = f"only {ctx.rated_count}/{len(cases)} cases were rated (skipped {ctx.skipped_count})"

    cert = print_certificate(
        passed=passed, dataset=dataset, ctx=ctx, gate=gate, scorer_label=scorer_label, rows=rows,
        case_count=len(cases), dash=dashboard_base(client), mode=mode, reason=reason,
    )
    if args.certificate_json:
        Path(args.certificate_json).write_text(json.dumps(cert, indent=2, default=str) + "\n")
        print(f"certificate written to {args.certificate_json}")
    client.close()
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
