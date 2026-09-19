---
name: refund-desk
description: Review ClaimSight claims that are waiting for a human (status pending_review), collect the manager's approve/deny decision for each, apply it through the ClaimSight API, and post a compact summary to Slack. Also runs the daily 9:00 claims digest.
version: 1.0.0
---

# Refund Desk (ClaimSight)

ClaimSight is the after-sales agent for Northwind Home. It refunds or replaces on its own when
policy allows and parks everything else in a human queue. This skill is the human side of that
queue: a manager clears it from WorkBuddy without opening the web desk.

Configuration (see `config.yaml`): `CLAIMSIGHT_URL` is the backend base URL
(local: `http://localhost:8088`, or the deployed EdgeOne Makers URL). `CLAIMSIGHT_UI_URL`
defaults to `CLAIMSIGHT_URL`. No API key is needed for the endpoints below. Never paste keys
into chat or Slack.

## Trigger

Use this skill when the manager says any of:

- "refund desk", "open the refund desk", "claims queue"
- "what's waiting for approval", "anything pending", "pending claims"
- "approve / deny claims", "clear the queue"
- "yesterday's claims", "claims digest", "claims report"
- or when the scheduled automation **Daily 9:00 claims digest** fires.

## Instructions

Work through the steps in order. Every HTTP call is plain JSON; report HTTP errors verbatim and
do not retry blindly.

1. **Fetch the queue**

   `GET {CLAIMSIGHT_URL}/claims-list?status=pending_review`

   Response: a JSON array, newest first. Each claim looks like

   ```json
   {
     "claim_id": "clm_7f2a", "display_id": "C-A1050-7F2A", "order_id": "A1050", "customer_id": "c_carol", "customer_name": "Carol Nguyen", "sku": "HDPH-02",
     "video_id": "vid_...", "evidence_summary": "Over-ear headphones; crack across the right hinge at 0:05.",
     "damage_assessment": "hinge cracked", 
     "fraud": {"checked": true, "matches": [{"video_id": "vid_...", "claim_id": "clm_...", "display_id": "C-A1042-81D3", "score": 0.94, "customer_id": "c_alice", "customer_name": "Alice Moreno"}]},
     "decision": {"action": "escalated", "amount": 129.0, "reason": "Amount above $75 auto-approve limit",
                  "policy_clauses": ["P2", "P3"], "by": "agent"},
     "status": "pending_review", "created_at": "2026-09-19T09:12:44Z", "latency_ms": 18342
   }
   ```

   If the array is empty, reply "Refund Desk: nothing is waiting for review." and stop (on the
   scheduled run still post that one line to Slack).

2. **Summarize each claim** in this shape (one block per claim, numbered):

   ```
   1) C-A1050-7F2A · Order A1050 · HDPH-02 · $129.00 · Carol Nguyen · waiting 2h
      Evidence: Over-ear headphones; crack across the right hinge at 0:05.
      Fraud matches: 0
      Agent recommends: refund — Amount above $75 auto-approve limit (P2, P3)
   ```

   - Amount = `decision.amount`; if `decision.action` is `replacement`, say "replacement" instead of a dollar figure.
   - Fraud matches = length of `fraud.matches`; when > 0 list each match as `display_id` · `customer_name` · `score` and add the warning "same footage as another account".
   - "Agent recommends" = `decision.action` + `decision.reason` + clauses. The clauses mean:
     P1 30-day window from delivery · P2 damage must be visible in evidence · P3 amounts above $75 need human approval ·
     P4 kitchen/lighting items are replaced first when in stock · P5 matching evidence across accounts is suspected fraud · P6 worn apparel is not returnable.

3. **Ask the manager for a decision per claim**: "Approve, deny, or skip? (e.g. 'approve 1, deny 2, skip 3' or 'approve all')".
   Never decide yourself. If a claim has any fraud match, require an explicit confirmation before approving it
   ("Claim 2 matches c_alice's clip at 0.94 — approve anyway?"). Ask for a short note when the manager denies.

4. **Apply each decision**

   `POST {CLAIMSIGHT_URL}/claims-decision` with header `Content-Type: application/json` and body

   ```json
   {"claim_id": "clm_7f2a", "decision": "approve", "note": "Manager: hinge crack confirmed, refund ok"}
   ```

   `decision` is `"approve"` or `"deny"`. Approving makes the server execute the refund/replacement with human
   approval (it calls its own `/refund` with `x-human-approved: true`), so the response includes a `txn_id` — quote it
   back to the manager. Denying sets the claim to `denied`. Skipped claims stay `pending_review`.
   On a non-2xx response say which claim failed and with what status; leave it in the queue.

5. **Post the summary to the connected Slack channel** (default `#refund-desk`, see `config.yaml`) using the format
   below. If Slack is not connected, show the same text in chat and say it was not posted.

6. Close with "Anything else for the desk?" and offer `{CLAIMSIGHT_UI_URL}/#desk` for the full table.

### Slack summary format

```
:package: *Refund Desk — 2026-09-19 09:41* — 3 claims reviewed by Priya
• C-A1050-7F2A · A1050 · HDPH-02 · $129.00 · Carol Nguyen — *APPROVED* → txn_8f3a12 (P2, P3 human approval)
• C-A1043-8800 · A1043 · MUG-01 · $24.00 · Mallory Quinn — *DENIED* — suspected fraud: matches C-A1042-81D3 / Alice Moreno (0.94) (P5)
• A1077 · TSHIRT-04 · $19.00 — *SKIPPED* — waiting for the customer's reply
Totals: approved $129.00 (1) · denied 1 · skipped 1 · fraud flags 1 · still pending 1
Desk: {CLAIMSIGHT_UI_URL}/#desk
```

Keep it to one line per claim; use `*APPROVED*`, `*DENIED*`, `*SKIPPED*`; always include the txn id for approvals.

### Automation recipe — Daily 9:00 claims digest

Schedule: every day at 09:00 (weekdays if the store is closed at weekends). Prompt for the automation:

> Summarize yesterday's ClaimSight claims into a .docx. Call `GET {CLAIMSIGHT_URL}/stats` (counters + last claims)
> and `GET {CLAIMSIGHT_URL}/claims-list` (all statuses), keep the claims whose `created_at` falls on yesterday's date, and
> compute: auto-approval rate (claims decided by the agent with action refund or replacement ÷ all claims), refunded $
> (sum of `decision.amount` where action is refund and status is auto_approved or approved), fraud flags (claims with
> at least one `fraud.matches` entry, list the matched customer ids), and the top damage types (count the
> `damage_assessment` values, top 5). Add a table of every escalated/denied claim with its reason and clauses.
> Save it as `ClaimSight-daily-<YYYY-MM-DD>.docx`, then post the four headline numbers and the file to #refund-desk.
> If there were no claims yesterday, say so in one line and skip the document.

Document outline: Title · Headline numbers (4 tiles) · Auto-approval rate vs the previous day · Refunded $ by SKU ·
Fraud flags (who matched whom) · Top damage types · Escalated/denied table · "Open the desk" link.

## Example

**Manager:** refund desk

**Assistant:** *(GET {CLAIMSIGHT_URL}/claims-list?status=pending_review)*
Three claims are waiting:

1) Order A1050 · HDPH-02 · $129.00 · customer c_carol · waiting 2h
   Evidence: Over-ear headphones; crack across the right hinge at 0:05.
   Fraud matches: 0
   Agent recommends: refund — Amount above $75 auto-approve limit (P2, P3)

2) Order A1043 · MUG-01 · $24.00 · customer c_mallory · waiting 35m
   Evidence: White ceramic mug, chip on the rim at 0:03.
   Fraud matches: 1 — c_alice (0.94) — same footage as another account
   Agent recommends: escalated — Evidence matches order A1042 from a different account (P5)

3) Order A1077 · TSHIRT-04 · $19.00 · customer c_erin · waiting 10m
   Evidence: Grey t-shirt, stretched collar, no tags; hole near the hem at 0:04.
   Fraud matches: 0
   Agent recommends: denied — Worn apparel is not returnable (P6); customer disputes wear

Approve, deny, or skip each? (Claim 2 has a fraud match — I will ask you to confirm before approving it.)

**Manager:** approve 1, deny 2 — note "duplicate footage", skip 3

**Assistant:** *(POST {CLAIMSIGHT_URL}/claims-decision ×2)*
Done. A1050 approved → txn_8f3a12 ($129.00 refunded). A1043 denied (note: duplicate footage). A1077 left pending.
Posted to #refund-desk:

```
:package: *Refund Desk — 2026-09-19 09:41* — 3 claims reviewed by Priya
• C-A1050-7F2A · A1050 · HDPH-02 · $129.00 · Carol Nguyen — *APPROVED* → txn_8f3a12 (P2, P3 human approval)
• C-A1043-8800 · A1043 · MUG-01 · $24.00 · Mallory Quinn — *DENIED* — suspected fraud: matches C-A1042-81D3 / Alice Moreno (0.94) (P5)
• A1077 · TSHIRT-04 · $19.00 — *SKIPPED* — waiting for the customer's reply
Totals: approved $129.00 (1) · denied 1 · skipped 1 · fraud flags 1 · still pending 1
Desk: http://localhost:8088/desk
```

Anything else for the desk?
