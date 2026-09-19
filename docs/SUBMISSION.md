# Submission kit — The Executable World (Sept 19, 2026)

Submit on the official platform by **3:15 PM** (deadline 3:30): https://figstudio-hackathon-production.up.railway.app/e/executable-world-2026

## Fields

**Project name:** ClaimSight — Refunds with receipts

**Track:** AI Assistants (Track 1). Re-file under Production-ready AI Agent only if that field is thin at 2:30 PM and the after-sales framing survives.

**Short description (paste):**
ClaimSight is an after-sales teammate that verifies damage from the customer's own video, applies the merchant's refund policy from structured data (no vector DB), executes refunds and replacements itself, and detects returns fraud by matching evidence footage across accounts. Escalations flow to a human in Slack through a WorkBuddy skill. Every decision is traced and gated with AgentX (30-claim golden set, policy judge, CI gate, PII monitors). Refund limits are enforced server-side, so the model can never exceed policy.

**Technology stack:** EdgeOne Makers (agent runtime, cloud functions, Blob storage, AI Gateway, Pages hosting) · Claude Agent SDK with custom MCP tools · React 18 + Vite + TypeScript · Memories.ai Video Datalake (upload, index, captions, frame extraction, image search) · AgentX trace-eval (Python SDK, self-hosted engine) · WorkBuddy skill + Slack incoming webhook · VeloDB (Apache Doris) analytics · AWS (S3 evidence archive wired into the upload path; CloudFormation for the evidence bucket and an EC2 host running AgentX and the live-stream relay)

**Co-host / sponsor technologies used:** Tencent EdgeOne Makers, WorkBuddy, AgentX, Memories.ai, VeloDB, AWS

**Repository:** https://github.com/vnmoorthy/claimsight

**Product link:** [Makers deploy URL — fill in after `edgeone makers deploy`]

**Presentation:** docs/deck/ClaimSight-deck.pptx (10 slides) · docs/STORYBOARD.md (3-minute script)

## Screenshots to attach (in this order)
1. Chat with a finished Decision Card (auto-approved refund, A1042)
2. Refund Desk with the escalated fraud-twin claim (A1043) and its detail drawer
3. AgentX: evaluation run with the gate result (Evaluate → Runs)
4. AgentX: one claim trace (Observe → Live Traces)
5. Makers console: the deployed project (agents + functions)
6. Slack: the escalation message from the WorkBuddy Refund Desk skill

## Demo video (backup)
Record one clean run at 2:00 PM: `assets/demo-backup.mp4` (QuickTime screen recording, 1080p, under 2 minutes). Upload it with the submission if the form accepts a file; otherwise link it from the README.
