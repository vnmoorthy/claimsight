# Stage checklist — ClaimSight

## T-60 min
- [ ] Laptop on power, Wi-Fi + phone hotspot ready, notifications off (Do Not Disturb), screen never sleeps.
- [ ] Backend up: `edgeone makers dev -n claimsight` (real runtime) **or** `npm run dev:local` (fallback runtime). Confirm `curl localhost:8088/stats` returns JSON.
- [ ] UI up: `npm run dev` → http://localhost:5173. Browser zoom 110–125% for the projector; dark theme; one tab only.
- [ ] AgentX up: `agentx-trace-eval --dev` → http://localhost:4700 open in a second tab (Observe → Live Traces).
- [ ] `.env` has the real keys (`AI_GATEWAY_API_KEY`, `MEMORIES_API_KEY`, `MEMORIES_CLAIMS_COLLECTION`); `MEMORIES_STUB` unset. If anything is flaky: set `AGENT_MODE=deterministic` and `MEMORIES_STUB=1` — the demo looks identical.
- [ ] Evidence clips indexed (`npm run index:clips -- --write`), `data/demo_evidence.json` has the real video ids, fraud-twin similarity checked (threshold below the twin score).
- [ ] Backup recording (`assets/demo-backup.mp4`) copied to the desktop and tested in the player.

## T-5 min
- [ ] Refund Desk → **Reset demo data** (fresh ledger, empty queue).
- [ ] Chat tab, empty state visible, Order field = A1042, scenario chips visible.
- [ ] Deck open on slide 1 in the other window; presenter notes visible on the laptop only.

## During the demo
1. Chip **A1042 · Chipped mug** → File claim → narrate the trace → Decision Card (Refund issued).
2. Chip **A1043 · Same mug, other account** → File claim → fraud twin → "Open in Refund Desk".
3. Drawer → add note → **Deny claim** → toast.
4. (If time) AgentX tab: the two new traces; Evaluate → last run PASS.

## If it breaks
- Card never appears: wait 10 s; if still nothing, Refund Desk → Reset demo data → repeat once. Second failure → backup video.
- "Offline" in the top bar: backend died. In a terminal: `npm run dev:local` (10 s) → reload.
- Gateway slow: `AGENT_MODE=deterministic` in `.env`, restart backend (the policy engine runs the same steps).
