#!/usr/bin/env python3
"""Load ClaimSight claims into VeloDB Cloud (Apache Doris, MySQL protocol) - idempotent.

Reads  GET {CLAIMSIGHT_URL}/claims  (all statuses; `--status` narrows it) and upserts into
claims_events, claim_fraud_matches and evidence_captions. All three tables use Doris' UNIQUE KEY
model, so re-running replaces rows with the same key instead of duplicating them - safe to run
from cron every few minutes.

Usage:
  python velodb/load.py --schema          # apply velodb/schema.sql first (CREATE DATABASE/TABLE IF NOT EXISTS)
  python velodb/load.py                   # load everything from GET /claims
  python velodb/load.py --status pending_review
  python velodb/load.py --dry-run         # print the rows that would be written, no DB connection
  python velodb/load.py --from-file dump.json   # load a saved /claims response instead of calling the API

Environment (see .env.example):
  VELODB_HOST, VELODB_PORT=9030, VELODB_USER, VELODB_PASSWORD, VELODB_DB=claimsight
  VELODB_SSL=1     use TLS for the MySQL connection (VeloDB Cloud public endpoints)
  CLAIMSIGHT_URL   default http://localhost:8088
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE / "schema.sql"

CLAIM_COLUMNS = [
    "claim_id", "order_id", "customer_id", "sku", "action", "status", "amount", "currency",
    "fraud_matches", "fraud_top_video_id", "fraud_top_customer", "fraud_top_score", "policy_clauses",
    "latency_ms", "decided_by", "txn_id", "video_id", "conversation_id", "reason",
    "created_at", "decided_at", "loaded_at",
]
MATCH_COLUMNS = ["claim_id", "matched_video_id", "matched_claim_id", "matched_customer_id", "claimant_customer", "score", "created_at"]
CAPTION_COLUMNS = ["video_id", "claim_id", "order_id", "customer_id", "summary", "damage_observed", "caption", "frame_embedding", "created_at"]

STATUSES = ("auto_approved", "pending_review", "approved", "denied", "replacement")


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------
def fetch_claims(base_url: str, status: Optional[str], timeout: float = 30.0) -> List[Dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/claims"
    params = {"status": status} if status else None
    resp = requests.get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    claims = _unwrap(data)
    if not claims and not status:
        # Some builds require a status filter - sweep every status and merge by claim_id.
        merged: Dict[str, Dict[str, Any]] = {}
        for st in STATUSES:
            r = requests.get(url, params={"status": st}, timeout=timeout)
            if r.ok:
                for c in _unwrap(r.json()):
                    if c.get("claim_id"):
                        merged[c["claim_id"]] = c
        claims = list(merged.values())
    return claims


def _unwrap(data: Any) -> List[Dict[str, Any]]:
    if isinstance(data, list):
        return [c for c in data if isinstance(c, dict)]
    if isinstance(data, dict):
        for key in ("claims", "items", "data", "results"):
            if isinstance(data.get(key), list):
                return [c for c in data[key] if isinstance(c, dict)]
    return []


# ---------------------------------------------------------------------------
# Transform
# ---------------------------------------------------------------------------
def _dt(value: Any) -> Optional[str]:
    """ISO-8601 / epoch -> 'YYYY-MM-DD HH:MM:SS' (UTC) for Doris DATETIME."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            ts = value / 1000.0 if value > 1e11 else float(value)
            return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        s = str(value).strip().replace("Z", "+00:00")
        parsed = dt.datetime.fromisoformat(s)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(dt.timezone.utc).replace(tzinfo=None)
        return parsed.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OSError):
        return None


def _num(value: Any) -> Optional[float]:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> Optional[int]:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None


def _join(values: Any) -> Optional[str]:
    if isinstance(values, list):
        return ",".join(str(v) for v in values) or None
    return str(values) if values else None


def rows_for(claim: Dict[str, Any], loaded_at: str) -> Tuple[Tuple, List[Tuple], Optional[Tuple]]:
    decision = claim.get("decision") or {}
    fraud = claim.get("fraud") or {}
    matches = [m for m in (fraud.get("matches") or []) if isinstance(m, dict)]
    top = max(matches, key=lambda m: _num(m.get("score")) or 0.0) if matches else {}
    created = _dt(claim.get("created_at")) or loaded_at
    claim_row = (
        claim.get("claim_id"),
        claim.get("order_id"),
        claim.get("customer_id"),
        claim.get("sku"),
        decision.get("action") or ("escalated" if claim.get("status") == "pending_review" else None),
        claim.get("status"),
        _num(decision.get("amount")),
        claim.get("currency") or decision.get("currency") or "USD",
        len(matches),
        top.get("video_id"),
        top.get("customer_id"),
        _num(top.get("score")),
        _join(decision.get("policy_clauses")),
        _int(claim.get("latency_ms")),
        decision.get("by"),
        decision.get("txn_id"),
        claim.get("video_id"),
        claim.get("conversation_id"),
        (decision.get("reason") or "")[:512] or None,
        created,
        _dt(claim.get("decided_at")),
        loaded_at,
    )
    match_rows = [
        (
            claim.get("claim_id"),
            m.get("video_id"),
            m.get("claim_id"),
            m.get("customer_id"),
            claim.get("customer_id"),
            _num(m.get("score")),
            created,
        )
        for m in matches
        if m.get("video_id")
    ]
    caption_row = None
    if claim.get("video_id"):
        evidence = claim.get("evidence") if isinstance(claim.get("evidence"), dict) else {}
        caption_obj = claim.get("caption") or evidence.get("caption") or evidence or None
        damage = claim.get("damage_observed") or evidence.get("damage_observed") or claim.get("damage_assessment")
        embedding = claim.get("frame_embedding") or evidence.get("frame_embedding")
        caption_row = (
            claim.get("video_id"),
            claim.get("claim_id"),
            claim.get("order_id"),
            claim.get("customer_id"),
            claim.get("evidence_summary") or evidence.get("description"),
            _join(damage) if isinstance(damage, list) else (str(damage)[:512] if damage else None),
            json.dumps(caption_obj) if caption_obj else None,          # VARIANT accepts a JSON string
            json.dumps([float(x) for x in embedding]) if isinstance(embedding, list) and embedding else None,  # ARRAY<FLOAT>
            created,
        )
    return claim_row, match_rows, caption_row


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------
def connect():
    import pymysql  # imported lazily so --dry-run works without the driver

    host = os.getenv("VELODB_HOST")
    if not host:
        raise SystemExit("VELODB_HOST is not set (see velodb/README.md for the VeloDB Cloud MySQL endpoint)")
    kwargs: Dict[str, Any] = dict(
        host=host,
        port=int(os.getenv("VELODB_PORT", "9030")),
        user=os.getenv("VELODB_USER", "admin"),
        password=os.getenv("VELODB_PASSWORD", ""),
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=15,
    )
    if os.getenv("VELODB_SSL") == "1":
        kwargs["ssl"] = {"check_hostname": False}
    return pymysql.connect(**kwargs)


def apply_schema(conn, db: str) -> None:
    sql = SCHEMA_PATH.read_text()
    statements = [s.strip() for s in _split_sql(sql) if s.strip()]
    with conn.cursor() as cur:
        for stmt in statements:
            cur.execute(stmt.replace("claimsight", db) if db != "claimsight" else stmt)
    print(f"schema applied: {len(statements)} statements from {SCHEMA_PATH.name}")


def _split_sql(sql: str) -> Iterable[str]:
    buf: List[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        buf.append(line)
        if stripped.endswith(";"):
            yield "\n".join(buf).rstrip(";")
            buf = []
    if buf:
        yield "\n".join(buf)


def upsert(conn, table: str, columns: List[str], rows: List[Tuple], batch: int = 500) -> int:
    if not rows:
        return 0
    placeholders = ",".join(["%s"] * len(columns))
    sql = f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders})"
    written = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), batch):
            cur.executemany(sql, rows[i : i + batch])
            written += len(rows[i : i + batch])
    return written


# ---------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--claimsight-url", default=os.getenv("CLAIMSIGHT_URL", "http://localhost:8088"))
    ap.add_argument("--status", default=None, help="only claims with this status (default: all)")
    ap.add_argument("--schema", action="store_true", help="apply velodb/schema.sql before loading")
    ap.add_argument("--schema-only", action="store_true", help="apply the schema and exit")
    ap.add_argument("--dry-run", action="store_true", help="print rows, do not connect to VeloDB")
    ap.add_argument("--from-file", default=None, help="load a saved GET /claims JSON response instead of calling the API")
    args = ap.parse_args(argv)

    db = os.getenv("VELODB_DB", "claimsight")
    loaded_at = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    claims: List[Dict[str, Any]] = []
    if not args.schema_only:
        if args.from_file:
            claims = _unwrap(json.loads(Path(args.from_file).read_text()))
            print(f"read {len(claims)} claims from {args.from_file}")
        else:
            claims = fetch_claims(args.claimsight_url, args.status)
            print(f"fetched {len(claims)} claims from {args.claimsight_url.rstrip('/')}/claims" + (f"?status={args.status}" if args.status else ""))

    claim_rows: List[Tuple] = []
    match_rows: List[Tuple] = []
    caption_rows: List[Tuple] = []
    skipped = 0
    for claim in claims:
        if not claim.get("claim_id") or not claim.get("order_id"):
            skipped += 1
            continue
        c, m, cap = rows_for(claim, loaded_at)
        claim_rows.append(c)
        match_rows.extend(m)
        if cap:
            caption_rows.append(cap)
    if skipped:
        print(f"skipped {skipped} claims without claim_id/order_id")

    if args.dry_run:
        for row in claim_rows:
            print("claims_events      ", dict(zip(CLAIM_COLUMNS, row)))
        for row in match_rows:
            print("claim_fraud_matches", dict(zip(MATCH_COLUMNS, row)))
        for row in caption_rows:
            print("evidence_captions  ", dict(zip(CAPTION_COLUMNS, row)))
        print(f"dry-run: {len(claim_rows)} claims, {len(match_rows)} fraud matches, {len(caption_rows)} captions (nothing written)")
        return 0

    conn = connect()
    try:
        if args.schema or args.schema_only:
            apply_schema(conn, db)
            if args.schema_only:
                return 0
        with conn.cursor() as cur:
            cur.execute(f"USE {db}")
        n1 = upsert(conn, "claims_events", CLAIM_COLUMNS, claim_rows)
        n2 = upsert(conn, "claim_fraud_matches", MATCH_COLUMNS, match_rows)
        n3 = upsert(conn, "evidence_captions", CAPTION_COLUMNS, caption_rows)
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*), SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) FROM claims_events")
            total, pending = cur.fetchone()
        print(f"upserted {n1} claims_events, {n2} claim_fraud_matches, {n3} evidence_captions into {db} "
              f"(table now has {total} claims, {pending or 0} pending_review)")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
