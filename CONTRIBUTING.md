# Contributing to ClaimSight

Thanks for helping. ClaimSight is small on purpose: one agent, a handful of cloud functions, structured policy data, and a test harness that gates every change.

## Run it locally (no accounts needed)
```bash
npm install
cp .env.example .env
npm run dev:local     # backend on :8088 — memory storage, stubbed Memories.ai, deterministic policy engine
npm run dev           # UI on :5173
```

## Before you open a PR
```bash
npm run typecheck && npm run build
python eval/run_eval.py --dry-run --offline-scorer     # needs a local AgentX: agentx-trace-eval --dev
```
Add or update a golden case in `data/golden_claims.json` whenever you change policy behaviour. The CI gate fails the build if the mean rating drops below 7.5 or regresses.

## Where things live
- `agents/claims/` — the agent and its tools; `_deterministic.ts` mirrors the LLM decision procedure in code. Keep the two in sync.
- `cloud-functions/` — every side effect. Policy limits are enforced in `_ledger.ts`; never move that into the agent.
- `data/policy.json` — the clauses. Add a clause, cite it in both decision paths, add a golden case.
- `src/` — React app. Design tokens live in `src/index.css`.

## Style
TypeScript strict, no new runtime dependencies without a reason in the PR, secrets only in `.env`.
