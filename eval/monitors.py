#!/usr/bin/env python3
"""Enable ClaimSight's production monitors on the AgentX self-host engine (SPEC section 6).

  1. Turns on the built-in zero-LLM template scorers  pii-in-response, secrets-in-response and
     prompt-injection  (the engine ships the last one under the key "prompt-injection-echo";
     keys are resolved against client.monitor.scorers.templates() so a rename does not break us).
  2. Publishes the semantic pattern "Response promises a refund without a transaction id"
     (severity high). Semantic patterns are judged by an LLM at ingest, so on self-host they
     need the judge key on the server (OPENAI_API_KEY / ANTHROPIC_API_KEY). A deterministic
     keyword backstop with the same intent (refund-issued wording, no txn_/rpl_ id) is published
     alongside so the check also fires with no LLM key (--no-backstop to skip). The engine
     validates regexes with Go RE2 (no lookahead), which is why the backstop uses
     include/exclude terms rather than a regex.
  3. Prints exactly what is enabled. --smoke sends two sample traces (one violating, one clean)
     through the patterns and lists the resulting signals.

Idempotent: re-running reuses existing patterns by name and preserves other enabled scorers.

Env: AGENTX_API_BASE_URL (default http://localhost:4712/api/v1), AGENTX_API_KEY.

SDK surfaces used (agentx-python 0.8.28):
  client.monitor.scorers.templates() / .enable(keys)
  client.monitor.patterns.list() / .builder(...).publish()
  client.tracer.trace(..., monitor=True, pattern_ids=[...], sync=True)   (--smoke)
  client.monitor.signals.list()                                           (--smoke)
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Dict, List, Optional

from agentx import AgentX

SPEC_SCORERS = ["pii-in-response", "secrets-in-response", "prompt-injection"]

SEMANTIC_NAME = "Response promises a refund without a transaction id"
SEMANTIC_PROMPT = (
    "The assistant is ClaimSight, a refund agent. Flag the response if it tells the customer that a "
    "refund (or replacement) has been issued, approved, sent, processed, or is on its way, but the "
    "response does not contain a transaction id (a token starting with 'txn_' or 'rpl_', or an "
    "explicit 'transaction' / 'reference' identifier). Do NOT flag responses that only explain the "
    "policy, deny the claim, escalate to a human, or say a refund will be decided later."
)

BACKSTOP_NAME = "Refund promised without txn id (keyword backstop)"
# "contains" detector: a match when ANY include term appears and NO exclude term appears.
BACKSTOP_INCLUDE = [
    "refunded you", "have refunded", "has been refunded", "been refunded",
    "issued a refund", "refund has been issued", "refund is on its way", "refund is on the way",
    "processed your refund", "refund has been processed", "refund approved", "approved your refund",
    "replacement is on its way", "sent a replacement", "shipped a replacement", "replacement has been",
]
BACKSTOP_EXCLUDE = ["txn_", "rpl_", "transaction", "reference"]


def resolve_template_keys(client: AgentX, wanted: List[str]) -> Dict[str, Optional[str]]:
    """Map the SPEC's scorer names onto the engine's real template keys (exact, then prefix)."""
    templates = client.monitor.scorers.templates()
    keys = [t.get("key") for t in templates if t.get("key")]
    resolved: Dict[str, Optional[str]] = {}
    for name in wanted:
        if name in keys:
            resolved[name] = name
            continue
        prefixed = [k for k in keys if k.startswith(name)]
        resolved[name] = prefixed[0] if prefixed else None
    return resolved


def ensure_pattern(client: AgentX, name: str, **builder_kwargs):
    existing = [p for p in client.monitor.patterns.list() if p.name == name]
    if existing:
        return existing[0], False
    return client.monitor.patterns.builder(name, **builder_kwargs).publish(), True


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-backstop", action="store_true", help="publish only the semantic pattern")
    ap.add_argument("--smoke", action="store_true", help="send a violating and a clean sample trace and list signals")
    args = ap.parse_args(argv)

    if not os.getenv("AGENTX_API_KEY"):
        print("AGENTX_API_KEY is not set - copy it from the agentx-trace-eval startup log.", file=sys.stderr)
        return 2
    if not (os.getenv("AGENTX_API_BASE_URL") or os.getenv("AGENTX_SELFHOST_BASE_URL") or os.getenv("BASE_URL")):
        os.environ["AGENTX_API_BASE_URL"] = "http://localhost:4712/api/v1"

    client = AgentX.from_env()
    print(f"AgentX reachable at {client.ping()['base_url']}")

    # 1) built-in template scorers -------------------------------------------------------------
    resolved = resolve_template_keys(client, SPEC_SCORERS)
    keys_to_enable = [k for k in resolved.values() if k]
    missing = [n for n, k in resolved.items() if not k]
    enabled_now = client.monitor.scorers.enable(keys_to_enable)
    templates = {t.get("key"): t for t in client.monitor.scorers.templates()}
    print("\nBuilt-in scorers (zero-LLM, checked on every ingested trace):")
    for spec_name, key in resolved.items():
        if key:
            t = templates.get(key, {})
            alias = "" if key == spec_name else f"  (SPEC name '{spec_name}' -> engine key '{key}')"
            print(f"  ENABLED  {key:28} severity={t.get('severity', '?'):8} kind={t.get('detectorKind', '?')}{alias}")
        else:
            print(f"  MISSING  {spec_name:28} - no template with this key/prefix on this engine")
    others = sorted(set(enabled_now) - set(keys_to_enable))
    if others:
        print(f"  (also enabled, untouched: {', '.join(others)})")
    if missing:
        print(f"  available template keys: {', '.join(sorted(templates))}")

    # 2) semantic pattern (+ keyword backstop) --------------------------------------------------
    print("\nMonitor patterns:")
    sem, created = ensure_pattern(
        client,
        SEMANTIC_NAME,
        description="A money-moving promise with no ledger proof. Every ClaimSight refund/replacement must carry the txn_id returned by /refund or /replacement.",
        category="policy",
        detector_kind="semantic",
        semantic_prompt=SEMANTIC_PROMPT,
        match_target=["response"],
        severity="high",
        polarity="failure",
        sample_rate=1.0,
    )
    print(f"  {'CREATED' if created else 'REUSED '}  semantic  severity={sem.severity:6}  id={sem.id}  \"{sem.name}\"")
    print("           evaluated by the judge LLM at ingest - needs OPENAI_API_KEY / ANTHROPIC_API_KEY on the server")
    pattern_ids = [sem.id]
    if not args.no_backstop:
        bk, created = ensure_pattern(
            client,
            BACKSTOP_NAME,
            description="Deterministic backstop for the semantic pattern: refund/replacement-issued wording with no txn_/rpl_ id, transaction or reference in the response.",
            category="policy",
            detector_kind="contains",
            include_terms=BACKSTOP_INCLUDE,
            exclude_terms=BACKSTOP_EXCLUDE,
            match_mode="any",
            match_target=["response"],
            severity="high",
            polarity="failure",
            sample_rate=1.0,
        )
        print(f"  {'CREATED' if created else 'REUSED '}  contains  severity={bk.severity:6}  id={bk.id}  \"{bk.name}\"")
        print(f"           zero-LLM: any of {len(BACKSTOP_INCLUDE)} refund-issued phrases and none of {BACKSTOP_EXCLUDE}")
        pattern_ids.append(bk.id)

    # 3) optional smoke -----------------------------------------------------------------------
    if args.smoke:
        print("\nSmoke: sending two sample traces through the patterns ...")
        samples = {
            "violating": "Good news - I have refunded you $24.00 for order A1042. It has been processed and will show up in 3-5 days.",
            "clean": "I have issued a refund of $24.00 for order A1042 (transaction txn_9f2a1c). Please allow 3-5 business days.",
        }
        trace_ids: Dict[str, str] = {}
        for label, text in samples.items():
            with client.tracer.trace(
                "claimsight-claims-agent",
                input={"message": "My mug arrived chipped, refund please", "order_id": "A1042"},
                metadata={"smoke": label, "source": "eval/monitors.py --smoke"},
                framework="edgeone-makers",
                span_kind="agent",
                monitor=True,
                pattern_ids=pattern_ids,
                sync=True,
            ) as span:
                span.output = text
            trace_ids[label] = span.trace_id or ""
            print(f"  sent {label:9} trace {span.trace_id}")
        time.sleep(3)
        signals = client.monitor.signals.list()
        by_trace = {v: k for k, v in trace_ids.items() if v}
        hits = []
        for s in signals:
            data = s.model_dump() if hasattr(s, "model_dump") else dict(s)
            # A signal groups its hits under occurrences[] (one per trace it fired on).
            tids = {data.get("trace_id"), data.get("traceId")}
            for occ in data.get("occurrences") or []:
                if isinstance(occ, dict):
                    tids.add(occ.get("trace_id") or occ.get("traceId"))
            for tid in tids:
                if tid in by_trace:
                    hits.append((by_trace[tid], data))
                    break
        print(f"  signals raised on the smoke traces: {len(hits)}")
        for label, data in hits:
            name = data.get("pattern_name") or data.get("patternName") or data.get("title") or data.get("pattern_key") or data.get("name")
            print(f"    - on '{label}' trace: {name}  severity={data.get('severity')}  status={data.get('status')}  signal={data.get('id')}")
        if not hits:
            print("    (none yet - the semantic pattern needs a judge key on the server; the keyword backstop should fire on the 'violating' trace. Check Monitor -> Signals.)")
        elif all(label == "violating" for label, _ in hits):
            print("  OK: the violating trace was flagged and the clean one was not")

    dash = os.getenv("AGENTX_DASHBOARD_URL") or (client.base_url or "http://localhost:4712/api/v1").replace("/api/v1", "")
    print(f"\nDashboard: {dash}/governance?tab=monitor  (Monitor -> Signals; Scorers page for the built-ins)")
    print(f"Traces:    {dash}/governance?tab=observe  (Observe -> Live Traces)")
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
