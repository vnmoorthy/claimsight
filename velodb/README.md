# ClaimSight × VeloDB Cloud (optional analytics)

The Makers KV store is the source of truth; VeloDB is the analytics layer on top of it:
auto-approval rate by hour, $ refunded, fraud clusters by matched video, p95 latency, and top
damage types straight from the Memories.ai captions (kept as `VARIANT`, with a frame embedding
column for similarity queries).

```
velodb/
  schema.sql      # claims_events, claim_fraud_matches, evidence_captions (UNIQUE KEY tables)
  load.py         # GET {CLAIMSIGHT_URL}/claims -> upsert (idempotent, pymysql)
  dashboard.sql   # the dashboard queries
  README.md
```

## 1. Sign up and create a warehouse

1. Create an account at <https://www.velodb.cloud/signup> (free trial; a work email speeds up approval).
2. Console → **Warehouses** → **New warehouse**. Pick the cloud/region closest to your Makers
   deployment, the smallest cluster size, and name it `claimsight`. Wait until the status is
   **Running** (a few minutes).
3. Open the warehouse → **Connect** (or **Endpoints**) and note:
   - **MySQL endpoint host** (something like `xxxx.velodb.cloud`) and **port `9030`**
   - the **admin user** and the password you set when creating the warehouse
4. **Network** → add your current public IP (and the CI runner's) to the allow-list, otherwise the
   connection times out.

Verify from a shell (any MySQL 8 client works):

```bash
mysql -h <host> -P 9030 -u admin -p -e "SELECT 1"
```

## 2. Configure

Add to `claimsight/.env` (already listed in `.env.example`):

```bash
VELODB_HOST=xxxx.velodb.cloud
VELODB_PORT=9030
VELODB_USER=admin
VELODB_PASSWORD=...
VELODB_DB=claimsight
# VELODB_SSL=1          # if the endpoint requires TLS
CLAIMSIGHT_URL=http://localhost:8088   # or the deployed Makers URL
```

Python deps: `pip install -r eval/requirements.txt` (pymysql + requests) in the same venv the
eval kit uses.

## 3. Run the schema

Either with the MySQL client:

```bash
mysql -h $VELODB_HOST -P $VELODB_PORT -u $VELODB_USER -p < velodb/schema.sql
```

or through the loader (splits and executes `schema.sql`, `IF NOT EXISTS` everywhere):

```bash
set -a; source .env; set +a
python velodb/load.py --schema-only
```

Self-hosted single-node Doris only: append `PROPERTIES ("replication_num" = "1")` to each
`CREATE TABLE` — VeloDB Cloud manages replication itself.

## 4. Load claims

```bash
python velodb/load.py                 # GET $CLAIMSIGHT_URL/claims -> upsert everything
python velodb/load.py --status pending_review
python velodb/load.py --dry-run       # show the rows without touching VeloDB
python velodb/load.py --from-file claims.json   # load a saved /claims response
```

Every table is a `UNIQUE KEY` table, so re-running replaces rows instead of duplicating them.
Schedule it:

```bash
*/5 * * * *  cd /path/to/claimsight && set -a && . ./.env && set +a && python velodb/load.py >> velodb/load.log 2>&1
```

What gets written per claim: one `claims_events` row (action, amount, fraud summary, latency,
decided_by, txn_id, timestamps), one `claim_fraud_matches` row per fraud match, and one
`evidence_captions` row per evidence video (summary, `damage_observed`, the raw caption JSON as
`VARIANT`, `frame_embedding` as `ARRAY<FLOAT>` when the backend includes it).

## 5. Dashboard queries

Open the warehouse's **SQL editor** (or `mysql -h ... -P 9030 -u ... -p claimsight`) and run the
blocks in `velodb/dashboard.sql`:

| # | Query | What it answers |
|---|-------|-----------------|
| 1 | auto-approval rate by hour | how much the agent handles on its own, hour by hour |
| 2 | $ refunded (total, today, by SKU) | money moved, and which product drives it |
| 3 | fraud clusters by matched video | which clip keeps reappearing, from how many accounts |
| 4 | p50 / p95 latency, by hour | how long a decision takes end to end |
| 5 | stats strip | the four numbers the UI shows, in one row |
| 6 | top damage types | `LATERAL VIEW EXPLODE` over the `VARIANT` caption |
| 7 | near-duplicate evidence by embedding | `COSINE_DISTANCE` on `frame_embedding`, cross-account |
| 8 | human queue age | what the WorkBuddy Refund Desk is looking at |

Pin queries 1, 2, 3 and 4 as charts on a VeloDB dashboard (or point Grafana/Metabase at the
MySQL endpoint) for the demo screen.

## Troubleshooting

- `Can't connect ... (timed out)` — your IP is not on the warehouse allow-list.
- `Access denied` — wrong user/password; VeloDB Cloud users are per-warehouse.
- `errCode = 2, detailMessage = ... replication` on self-hosted Doris — add `replication_num = "1"`.
- `Unknown column type VARIANT` — the cluster runs a Doris version below 2.1; change the `caption`
  column to `JSON` (query 6 then uses `JSON_EXTRACT`) or upgrade the warehouse.
- `load.py` prints `fetched 0 claims` — the backend needs claims first; send one through the
  ClaimSight chat (order A1042 is the clean auto-approve demo) and re-run.


## Validated locally against Apache Doris

VeloDB Cloud is built on Apache Doris, so the kit can be exercised without an account:

```bash
docker run -d --name claimsight-doris -p 9030:9030 -p 8030:8030 apache/doris:doris-all-in-one-2.1.0   # ~10 GB image, 2–3 min to boot
export VELODB_HOST=127.0.0.1 VELODB_PORT=9030 VELODB_USER=root VELODB_PASSWORD= VELODB_DB=claimsight
# single node: append  PROPERTIES ("replication_num" = "1")  to each CREATE TABLE (sed 's/BUCKETS 4;/BUCKETS 4 PROPERTIES ("replication_num" = "1");/')
python velodb/load.py --schema          # applies the schema, then upserts GET /claims-list from the running backend
mysql -h 127.0.0.1 -P 9030 -u root claimsight < velodb/dashboard.sql
```

Result on Sept 19, 2026: schema applied, `upserted 3 claims_events, 1 claim_fraud_matches, 3 evidence_captions`, 12 dashboard queries ran, 0 failed.
