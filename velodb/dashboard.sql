-- ClaimSight dashboard queries for VeloDB Cloud (run in the VeloDB SQL editor or `mysql -h ... -P 9030`).
-- Tables: claims_events, claim_fraud_matches, evidence_captions (see schema.sql; filled by load.py).
USE claimsight;

-- 1) Auto-approval rate by hour (agent-decided refunds/replacements over all claims), last 48 hours of data
SELECT
    DATE_FORMAT(created_at, '%Y-%m-%d %H:00')                                           AS hour,
    COUNT(*)                                                                             AS claims,
    SUM(CASE WHEN decided_by = 'agent' AND action IN ('refund', 'replacement') THEN 1 ELSE 0 END) AS auto_approved,
    SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END)                                AS escalated,
    SUM(CASE WHEN action = 'denied' THEN 1 ELSE 0 END)                                   AS denied,
    ROUND(100.0 * SUM(CASE WHEN decided_by = 'agent' AND action IN ('refund', 'replacement') THEN 1 ELSE 0 END) / COUNT(*), 1) AS auto_approval_pct
FROM claims_events
GROUP BY 1
ORDER BY 1 DESC
LIMIT 48;

-- 2) $ refunded: overall, today, and by SKU
SELECT
    ROUND(SUM(CASE WHEN action = 'refund' AND status IN ('auto_approved', 'approved') THEN amount ELSE 0 END), 2) AS refunded_usd_total,
    ROUND(SUM(CASE WHEN action = 'refund' AND status IN ('auto_approved', 'approved') AND DATE(created_at) = CURDATE() THEN amount ELSE 0 END), 2) AS refunded_usd_today,
    SUM(CASE WHEN action = 'replacement' THEN 1 ELSE 0 END) AS replacements,
    COUNT(*)                                                 AS claims
FROM claims_events;

SELECT
    sku,
    COUNT(*)                                                                                   AS claims,
    ROUND(SUM(CASE WHEN action = 'refund' AND status IN ('auto_approved', 'approved') THEN amount ELSE 0 END), 2) AS refunded_usd,
    SUM(CASE WHEN action = 'replacement' THEN 1 ELSE 0 END)                                    AS replacements,
    SUM(CASE WHEN action = 'denied' THEN 1 ELSE 0 END)                                         AS denied
FROM claims_events
GROUP BY sku
ORDER BY refunded_usd DESC;

-- 3) Fraud clusters by matched video: which evidence clip keeps showing up, from how many accounts
SELECT
    m.matched_video_id                                   AS matched_video,
    COUNT(DISTINCT m.claim_id)                           AS claims_matching_it,
    COUNT(DISTINCT m.claimant_customer)                  AS distinct_claimants,
    GROUP_CONCAT(DISTINCT m.claimant_customer)           AS claimants,
    MAX(m.matched_customer_id)                           AS original_customer,
    ROUND(MAX(m.score), 3)                               AS top_score,
    ROUND(AVG(m.score), 3)                               AS avg_score
FROM claim_fraud_matches m
WHERE m.score >= 0.80
GROUP BY m.matched_video_id
ORDER BY claims_matching_it DESC, top_score DESC;

-- 3b) The same from the fact table alone (no match table needed)
SELECT
    fraud_top_video_id                       AS matched_video,
    COUNT(*)                                 AS flagged_claims,
    COUNT(DISTINCT customer_id)              AS distinct_claimants,
    GROUP_CONCAT(DISTINCT customer_id)       AS claimants,
    ROUND(MAX(fraud_top_score), 3)           AS top_score
FROM claims_events
WHERE fraud_matches > 0
GROUP BY fraud_top_video_id
ORDER BY flagged_claims DESC;

-- 4) Latency: p50 / p95 / max overall and by hour (agent decision latency in ms)
SELECT
    COUNT(*)                          AS claims,
    ROUND(AVG(latency_ms))            AS avg_ms,
    PERCENTILE(latency_ms, 0.50)      AS p50_ms,
    PERCENTILE(latency_ms, 0.95)      AS p95_ms,
    MAX(latency_ms)                   AS max_ms
FROM claims_events
WHERE latency_ms IS NOT NULL;

SELECT
    DATE_FORMAT(created_at, '%Y-%m-%d %H:00') AS hour,
    COUNT(*)                                  AS claims,
    PERCENTILE(latency_ms, 0.95)              AS p95_ms
FROM claims_events
WHERE latency_ms IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC
LIMIT 48;

-- 5) Stats strip in one row (mirrors GET /stats: auto-approval %, refunded $, fraud flags, median latency)
SELECT
    ROUND(100.0 * SUM(CASE WHEN decided_by = 'agent' AND action IN ('refund', 'replacement') THEN 1 ELSE 0 END) / COUNT(*), 1) AS auto_approval_pct,
    ROUND(SUM(CASE WHEN action = 'refund' AND status IN ('auto_approved', 'approved') THEN amount ELSE 0 END), 2)             AS refunded_usd,
    SUM(CASE WHEN fraud_matches > 0 THEN 1 ELSE 0 END)                                                                          AS fraud_flags,
    PERCENTILE(latency_ms, 0.50)                                                                                                AS median_latency_ms,
    SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END)                                                                  AS pending_review
FROM claims_events;

-- 6) Top damage types from the evidence captions (VARIANT -> array -> explode)
SELECT
    damage                          AS damage_type,
    COUNT(*)                        AS videos
FROM evidence_captions
    LATERAL VIEW EXPLODE(CAST(caption['damage_observed'] AS ARRAY<STRING>)) d AS damage
GROUP BY damage
ORDER BY videos DESC
LIMIT 10;

-- 6b) Same, from the flattened column (works even when caption is NULL)
SELECT damage AS damage_type, COUNT(*) AS videos
FROM evidence_captions
    LATERAL VIEW EXPLODE_SPLIT(damage_observed, ',') d AS damage
WHERE damage_observed IS NOT NULL AND damage_observed <> ''
GROUP BY damage
ORDER BY videos DESC
LIMIT 10;

-- 7) Near-duplicate evidence by embedding (candidate fraud pairs across accounts) - requires frame_embedding
SELECT
    a.video_id                                              AS video_a,
    a.customer_id                                           AS customer_a,
    b.video_id                                              AS video_b,
    b.customer_id                                           AS customer_b,
    ROUND(1 - COSINE_DISTANCE(a.frame_embedding, b.frame_embedding), 4) AS similarity
FROM evidence_captions a
JOIN evidence_captions b
    ON a.video_id < b.video_id
WHERE a.frame_embedding IS NOT NULL AND b.frame_embedding IS NOT NULL
  AND a.customer_id <> b.customer_id
ORDER BY similarity DESC
LIMIT 20;

-- 8) Human queue age (what the WorkBuddy Refund Desk sees)
SELECT claim_id, order_id, sku, amount, fraud_matches, reason,
       TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS waiting_minutes
FROM claims_events
WHERE status = 'pending_review'
ORDER BY created_at ASC;
