#!/usr/bin/env python3
"""ClaimSight fraud-twin lab -> AgentX dataset + gated run.

Reads public/lab/results.json (written by `npm run lab`), then:
  1. creates or reuses the AgentX dataset "ClaimSight fraud-twin lab" with one case per twin pair
     (two clips of the same damaged item re-filmed under different conditions, sometimes mirrored);
  2. runs it with a deterministic in-engine code scorer: 10 when the detector caught the pair at the
     recommended threshold, else 0 (the "agent" replays results.json - nothing is re-rendered);
  3. gates the run with fail_under=8 (>= 80 % of twin pairs detected) and exits non-zero on failure.

Only runs when AGENTX_API_KEY is set (exit 0 with a note otherwise). Same SDK surfaces as
eval/run_eval.py (agentx-python 0.8.28): AgentX.from_env(), evaluations.datasets, monitor.scorers /
scorer_groups, evaluations.run(...).execute(...).finalize().gate(...), tracer.trace(...).

  python eval/lab_eval.py [--results public/lab/results.json] [--recreate-dataset] [--fail-under 8]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, List

DATASET_NAME = "ClaimSight fraud-twin lab"
CODE_SCORER_NAME = "ClaimSight twin detected"
SCORER_GROUP_NAME = "ClaimSight fraud-twin lab gate"
AGENT_TRACE_NAME = "claimsight.lab.twin_pair"
PAIR_TAG_RE = re.compile(r"\[pair=([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)\]")

# Runs inside the AgentX engine, per result. Output is the JSON the lab "agent" returns.
CODE_SCORER_SCRIPT = textwrap.dedent(
    r'''
    import json

    def _text(v):
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            for k in ("text", "output", "response"):
                if isinstance(v.get(k), str):
                    return v[k]
            return json.dumps(v, default=str)
        return str(v)

    def handler(input, output, expected, metadata, trace):
        meta = metadata if isinstance(metadata, dict) else {}
        try:
            got = json.loads(_text(output))
        except Exception:
            got = {}
        if not isinstance(got, dict) or "detected" not in got:
            return None  # not a lab result (e.g. sampled live traffic) - skip
        detected = bool(got.get("detected"))
        score = 1.0 if detected else 0.0
        notes = [
            "pair=%s|%s" % (got.get("a"), got.get("b")),
            "score=%s" % got.get("score"),
            "threshold=%s" % got.get("threshold"),
            "mirrored=%s" % got.get("mirrored"),
            "detected" if detected else "MISSED",
        ]
        return {"score": score, "name": "twin-detected", "reasoning": "; ".join(notes)}
    '''
).strip() + "\n"


def load_results(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"{path} not found - run `npm run lab -- --count 24 --seed 7` first")
    data = json.loads(path.read_text())
    pairs = data.get("twin_pairs")
    if not isinstance(pairs, list) or not pairs:
        raise SystemExit(f"{path}: no twin_pairs (render more clips or raise --twin-rate)")
    return data


def query_for(pair: Dict[str, Any], results: Dict[str, Any]) -> str:
    return (
        f"[pair={pair['a']}|{pair['b']}] Two customer evidence clips were filed against different orders. "
        f"Clip {pair['a']} and clip {pair['b']} show the same {pair.get('product', 'item')} with the same "
        f"{pair.get('damage_type') or 'damage'}, re-filmed under different lighting, background and camera motion"
        + (", mirrored" if pair.get("mirrored") else "")
        + f". Detector: {results.get('detector')}. Should the fraud-twin check flag the second clip?"
    )


def expected_for(pair: Dict[str, Any], results: Dict[str, Any]) -> str:
    return json.dumps(
        {
            "expected": "twin_detected",
            "group_id": pair.get("group_id"),
            "a": pair["a"],
            "b": pair["b"],
            "mirrored": bool(pair.get("mirrored")),
            "recommended_threshold": results.get("recommended_threshold"),
        }
    )


def find_dataset(client, name: str):
    matches = [d for d in client.evaluations.datasets.list() if d.name == name]
    return matches[0] if matches else None


def ensure_dataset(client, results: Dict[str, Any], recreate: bool):
    pairs: List[Dict[str, Any]] = results["twin_pairs"]
    existing = find_dataset(client, DATASET_NAME)
    if existing and recreate:
        print(f"  deleting dataset {existing.id} ({DATASET_NAME}) for rebuild")
        client.evaluations.datasets.delete(existing.id)
        existing = None
    if existing:
        have = {tuple(m.groups()) for q in existing.questions for m in [PAIR_TAG_RE.search(q.main_question.query or "")] if m}
        want = {(p["a"], p["b"]) for p in pairs}
        if have != want:
            print(f"  WARNING: dataset {existing.id} holds {len(have)} pairs, results.json has {len(want)}. Re-run with --recreate-dataset.")
        print(f"  reusing dataset {existing.id}  \"{DATASET_NAME}\"  ({len(existing.questions)} cases)")
        return existing
    builder = client.evaluations.datasets.builder(
        DATASET_NAME,
        description=(
            "Synthetic Evidence Lab twin pairs (blender/synth_evidence.py): the same damaged item re-filmed under "
            "different lighting / background / camera, sometimes mirrored. One case per pair; built from "
            "public/lab/results.json by eval/lab_eval.py."
        ),
        number_of_requests=1,
        acceptance_criteria="The fraud-twin detector flags the re-filmed clip as the same item (score at or above the recommended threshold).",
        rejection_criteria="The pair is missed (score below the recommended threshold).",
        evaluation_criteria="Binary: detected → 10, missed → 0. Mirrored pairs count the same as plain ones.",
    )
    for p in pairs:
        builder.add_case(
            query=query_for(p, results),
            expected_results=expected_for(p, results),
            judge_guideline=f"{p['a']}|{p['b']} {p.get('product')} {p.get('damage_type')}{' mirrored' if p.get('mirrored') else ''}",
            splits=["mirrored"] if p.get("mirrored") else None,
        )
    ds = builder.publish()
    print(f"  created dataset {ds.id}  \"{DATASET_NAME}\"  ({len(ds.questions)} cases)")
    return ds


def ensure_scorer_group(client):
    code = [e for e in client.monitor.scorers.list() if e.get("name") == CODE_SCORER_NAME and e.get("kind") == "code"]
    if code:
        scorer = code[0]
        if scorer.get("script") != CODE_SCORER_SCRIPT:
            scorer = client.monitor.scorers.update(scorer["_id"], script=CODE_SCORER_SCRIPT, language="python")
            print(f"  updated code scorer {scorer['_id']}  \"{CODE_SCORER_NAME}\"")
        else:
            print(f"  reusing code scorer {scorer['_id']}  \"{CODE_SCORER_NAME}\"")
    else:
        scorer = client.monitor.scorers.create_code(
            CODE_SCORER_NAME, CODE_SCORER_SCRIPT, language="python", alert_below=0.5, sample_rate=0.0, severity="high",
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
            SCORER_GROUP_NAME, members=members,
            description="Fraud-twin lab gate: 10 when the twin pair was detected at the recommended threshold, else 0.",
        )
        print(f"  created scorer group {group.id}  \"{SCORER_GROUP_NAME}\"")
    return group


def make_agent(client, results: Dict[str, Any]):
    by_pair = {(p["a"], p["b"]): p for p in results["twin_pairs"]}
    threshold = results.get("recommended_threshold")

    def agent(evaluation_case):
        m = PAIR_TAG_RE.search(evaluation_case.query or "")
        if not m or (m.group(1), m.group(2)) not in by_pair:
            raise RuntimeError(f"cannot map dataset query to a twin pair: {(evaluation_case.query or '')[:80]!r}")
        pair = by_pair[(m.group(1), m.group(2))]
        answer = {
            "a": pair["a"], "b": pair["b"], "group_id": pair.get("group_id"), "product": pair.get("product"),
            "damage_type": pair.get("damage_type"), "mirrored": bool(pair.get("mirrored")),
            "score": pair.get("score"), "threshold": threshold, "detected": bool(pair.get("detected")),
            "detector": results.get("detector"),
        }
        with client.tracer.trace(
            AGENT_TRACE_NAME,
            input={"pair": f"{pair['a']}|{pair['b']}", "detector": results.get("detector")},
            metadata={"expected": "twin_detected", "mirrored": answer["mirrored"], "threshold": threshold},
            framework="claimsight-lab",
            span_kind="agent",
            session_id=f"lab-{pair['a']}-{pair['b']}",
            sync=True,
        ) as span:
            span.add_tool_call(
                "search_by_image", input={"clip": pair["a"], "top_k": 10},
                output={"match": pair["b"], "score": pair.get("score"), "threshold": threshold, "detected": answer["detected"]},
                latency_ms=1,
            )
            span.output = answer
            trace_id = span.trace_id
        return {"output": json.dumps(answer), "trace_id": trace_id, "metadata": answer}

    return agent


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", default=str(Path(__file__).resolve().parent.parent / "public" / "lab" / "results.json"))
    ap.add_argument("--recreate-dataset", action="store_true")
    ap.add_argument("--fail-under", type=float, default=8.0)
    ap.add_argument("--concurrency", type=int, default=3)
    args = ap.parse_args()

    if not os.getenv("AGENTX_API_KEY"):
        print("AGENTX_API_KEY is not set - skipping the AgentX lab evaluation (nothing to do).")
        return 0
    try:
        from agentx import AgentX
    except ImportError:
        print("agentx-python is not installed - pip install -r eval/requirements.txt", file=sys.stderr)
        return 2

    results = load_results(Path(args.results))
    pairs = results["twin_pairs"]
    print(f"Loaded {len(pairs)} twin pairs from {args.results} (detector {results.get('detector')}, threshold {results.get('recommended_threshold')})")

    client = AgentX.from_env()
    ping = client.ping()
    print(f"AgentX reachable at {ping['base_url']}")
    print("Dataset:")
    dataset = ensure_dataset(client, results, recreate=args.recreate_dataset)
    print("Scorer:")
    group = ensure_scorer_group(client)

    subject = {
        "kind": "custom_agent",
        "displayName": f"ClaimSight fraud-twin detector ({results.get('detector')})",
        "framework": "claimsight-lab",
        "runtime": "local",
        "metadata": {"detector": results.get("detector"), "recommended_threshold": results.get("recommended_threshold"),
                     "clips": (results.get("summary") or {}).get("clips")},
    }
    ctx = client.evaluations.run(dataset.id, subject, scorer_group_id=group.id)
    ctx = ctx.execute(make_agent(client, results), concurrency=args.concurrency).finalize()
    gate = ctx.gate(fail_under=args.fail_under, caller="eval/lab_eval.py")

    rows = ctx.results()
    detected = sum(1 for p in pairs if p.get("detected"))
    print("")
    print("LAB GATE")
    print(f"  Dataset   : {dataset.name} ({dataset.id})")
    print(f"  Run       : {getattr(ctx, 'run_id', '?')}  rated {ctx.rated_count}/{len(pairs)}  failed {ctx.failed_count}")
    print(f"  Detected  : {detected}/{len(pairs)} twin pairs at threshold {results.get('recommended_threshold')} ({results.get('detector')})")
    print(f"  Average   : {getattr(gate, 'average', None)}   fail_under={args.fail_under}")
    print(f"  Result    : {'PASS' if gate.passed and not ctx.failed_count else 'FAIL'}")
    for r in rows:
        just = (getattr(r, "justification", "") or "")[:100]
        print(f"    {getattr(r, 'score', '?')}  {just}")
    client.close()
    return 0 if (gate.passed and not ctx.failed_count) else 1


if __name__ == "__main__":
    sys.exit(main())
