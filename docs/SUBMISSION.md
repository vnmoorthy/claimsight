# Submission kit — The Executable World (Sept 19, 2026)

Submit on the official platform by **3:15 PM** (deadline 3:30): https://figstudio-hackathon-production.up.railway.app/e/executable-world-2026

## Fields

**Project name:** ClaimSight — Refunds with receipts

**Track:** AI Assistants (Track 1). Re-file under Production-ready AI Agent only if that field is thin at 2:30 PM and the after-sales framing survives.

**Short description (paste):**
ClaimSight is an after-sales teammate that verifies damage from the customer's own video, applies the merchant's refund policy from structured data (no vector DB), executes refunds and replacements itself, and detects returns fraud by matching evidence footage across accounts. Every decided claim gets a Damage Twin: a Blender-rendered 3D receipt with the damage marked exactly where Memories.ai saw it. The fraud detector was crash-tested in a Synthetic Evidence Lab: Blender renders labelled evidence clips (same damaged items re-filmed as if by different accounts), Memories.ai searches them, and the Lab tab reports recall, false-positive rate and the similarity threshold we ship. Escalations flow to a human in Slack through a WorkBuddy skill. Every decision is traced and gated with AgentX (31-claim golden set, policy judge, CI gate, PII monitors). Refund limits are enforced server-side, so the model can never exceed policy.

**Technology stack:** EdgeOne Makers (agent runtime, cloud functions, Blob storage, AI Gateway, Pages hosting) · Claude Agent SDK with custom MCP tools · React 18 + Vite + TypeScript · Memories.ai Video Datalake (upload, index, captions, frame extraction, image search; synthetic evidence lab) · Blender 5 headless (bpy: Damage Twin receipts, synthetic evidence generator; PNG sequence + ffmpeg) · AgentX trace-eval (Python SDK, self-hosted engine) · WorkBuddy skill + Slack incoming webhook · VeloDB (Apache Doris) analytics, validated on Doris · AWS (S3 evidence archive wired into the upload path; CloudFormation for the evidence bucket and an EC2 host running AgentX, the live-stream relay and the Blender render worker)

**Co-host / sponsor technologies used:** Tencent EdgeOne Makers, WorkBuddy, AgentX, Memories.ai, VeloDB, AWS

**Repository:** https://github.com/vnmoorthy/claimsight

**Product link:** [Makers deploy URL — fill in after `edgeone makers deploy`]

**Presentation:** docs/deck/ClaimSight-deck.pptx (10 slides) · docs/STORYBOARD.md (3-minute script)

## Demo-day status (say it before judges ask)
- Memories.ai: full Video Datalake client and evidence pipeline built and contract-tested; the account had no credits on the day, so the demo runs on canned evidence and the Lab uses a local perceptual-hash baseline. Switch is one env var (`MEMORIES_STUB=0`) plus `npm run go-live:memories`.
- AI model: no gateway key on the day, so the agent runs its policy engine; the LLM path is implemented (`AGENT_MODE=llm`) and falls back to the engine automatically.
- Live locally and verified: Blender Damage Twins (~27 s per claim), AgentX traces + 31-claim gate, S3 archive (S3-compatible store), VeloDB kit on Apache Doris.

## Screenshots to attach (in this order)
1. Chat with a finished Decision Card and the Damage Twin video (auto-approved refund, A1042)
2. Refund Desk with the escalated fraud-twin claim (A1043) and its detail drawer
2b. Lab tab: recall / false-positive curve and the synthetic clip gallery
3. AgentX: evaluation run with the gate result (Evaluate → Runs)
4. AgentX: one claim trace (Observe → Live Traces)
5. Makers console: the deployed project (agents + functions)
6. Slack: the escalation message from the WorkBuddy Refund Desk skill

## Demo video (backup)
Record one clean run at 2:00 PM: `assets/demo-backup.mp4` (QuickTime screen recording, 1080p, under 2 minutes). Upload it with the submission if the form accepts a file; otherwise link it from the README.
