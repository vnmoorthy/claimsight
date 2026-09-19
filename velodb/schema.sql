-- ClaimSight analytics schema for VeloDB Cloud (Apache Doris compatible, MySQL protocol).
-- Apply with:  mysql -h <host> -P 9030 -u <user> -p < velodb/schema.sql
--        or:   python velodb/load.py --schema
--
-- Notes
--  * Every table uses the UNIQUE KEY model, so re-inserting a row with the same key replaces it:
--    velodb/load.py is idempotent by construction (run it from cron every few minutes).
--  * On a single-node self-hosted Doris add  PROPERTIES ("replication_num" = "1")  to each table;
--    VeloDB Cloud manages replication itself, so it is omitted here.
--  * VARIANT keeps the raw Memories.ai caption JSON queryable (caption['timeline'], ...),
--    ARRAY<FLOAT> holds the frame embedding for similarity queries (cosine_distance / l2_distance).

CREATE DATABASE IF NOT EXISTS claimsight;
USE claimsight;

-- One row per claim decision (the fact table behind the dashboard).
CREATE TABLE IF NOT EXISTS claims_events (
    claim_id            VARCHAR(64)     NOT NULL COMMENT 'claims:<claim_id> in Makers KV',
    order_id            VARCHAR(32)     NOT NULL,
    customer_id         VARCHAR(64),
    sku                 VARCHAR(32),
    action              VARCHAR(16)     COMMENT 'refund | replacement | escalated | denied',
    status              VARCHAR(24)     COMMENT 'auto_approved | pending_review | approved | denied | replacement',
    amount              DECIMAL(10, 2),
    currency            VARCHAR(8),
    fraud_matches       INT             COMMENT 'number of matching videos from fraud_check',
    fraud_top_video_id  VARCHAR(128)    COMMENT 'best-scoring matched video (fraud cluster key)',
    fraud_top_customer  VARCHAR(64),
    fraud_top_score     DECIMAL(6, 4),
    policy_clauses      VARCHAR(64)     COMMENT 'comma-joined, e.g. P2,P4',
    latency_ms          INT,
    decided_by          VARCHAR(16)     COMMENT 'agent | human',
    txn_id              VARCHAR(64),
    video_id            VARCHAR(128),
    conversation_id     VARCHAR(128),
    reason              VARCHAR(512),
    created_at          DATETIME        NOT NULL,
    decided_at          DATETIME,
    loaded_at           DATETIME
)
UNIQUE KEY (claim_id)
COMMENT 'ClaimSight claim decisions'
DISTRIBUTED BY HASH (claim_id) BUCKETS 4;

-- Every fraud match a claim produced (a claim can match several videos) - for clustering.
CREATE TABLE IF NOT EXISTS claim_fraud_matches (
    claim_id            VARCHAR(64)     NOT NULL,
    matched_video_id    VARCHAR(128)    NOT NULL,
    matched_claim_id    VARCHAR(64),
    matched_customer_id VARCHAR(64),
    claimant_customer   VARCHAR(64),
    score               DECIMAL(6, 4),
    created_at          DATETIME
)
UNIQUE KEY (claim_id, matched_video_id)
DISTRIBUTED BY HASH (claim_id) BUCKETS 4;

-- What the evidence video showed: summary text, the raw caption JSON (VARIANT) and a frame embedding.
CREATE TABLE IF NOT EXISTS evidence_captions (
    video_id            VARCHAR(128)    NOT NULL COMMENT 'Memories.ai video id',
    claim_id            VARCHAR(64),
    order_id            VARCHAR(32),
    customer_id         VARCHAR(64),
    summary             TEXT            COMMENT 'inspect_evidence description',
    damage_observed     VARCHAR(512)    COMMENT 'comma-joined damage_observed list',
    caption             VARIANT         COMMENT 'raw caption/timeline/products_seen JSON from Memories.ai',
    frame_embedding     ARRAY<FLOAT>    COMMENT 'first-frame embedding (frame_embedding target) for similarity search',
    created_at          DATETIME
)
UNIQUE KEY (video_id)
DISTRIBUTED BY HASH (video_id) BUCKETS 4;
