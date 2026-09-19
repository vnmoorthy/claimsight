# ClaimSight — 3-minute stage storyboard (judges in the room: ServiceNow, TikTok, EdgeOne/WorkBuddy, AgentX)

Same demo, emphasis on the judges present. Deck on one screen, the app on the other. Reset demo data before you start.

| Time | Slide / app | You say | You do |
|---|---|---|---|
| 0:00 | 1–2 | "Return fraud cost US retailers 101 billion dollars in 2023. Every refund still needs a human to squint at a photo. ClaimSight is an after-sales teammate: it reads the evidence, applies your policy, executes the refund, and pulls a human in only when the rules say so." | Two slides, twenty-five seconds. |
| 0:25 | app | File A1042. "Order, policy, evidence, fraud check, execute, record. Policy and orders are structured data on EdgeOne Makers, no vector database. Refund limits are enforced by the refund service, not the prompt, so the model cannot exceed policy even if asked." | Chip A1042 → File claim. Point at the six steps, then the Decision Card. |
| 0:55 | app | "And the receipt is a 3D twin rendered in Blender, with the damage marked exactly where the video showed it." | The Damage Twin video appears in the card about 30 seconds after filing. Let it play for five seconds. |
| 1:15 | app | "Second customer, different account, same footage. The evidence is matched across prior claims, the claim freezes, and it escalates." | Chip A1043 → File claim. Point at the fraud panel. |
| 1:45 | app | "The manager decides in the desk or from Slack through a WorkBuddy skill. Every decision carries an audit note, the cited clauses, and a transaction id." | Open in Refund Desk → note → Deny claim. |
| 2:15 | 8 + Lab | "Thirty-one golden claims, a policy judge, a deploy gate that fails on regression, PII and secrets monitors, one trace per claim. And we crash-tested the fraud detector with a synthetic evidence set rendered in Blender: the Lab shows recall, false positives, and the threshold we ship." | Slide 8, then the Lab tab for ten seconds. |
| 2:45 | 10 | "Data to transaction in one loop, on EdgeOne Makers. Thank you." | Stop. One question. |

## If asked
- **Memories.ai?** "The evidence pipeline is built against their Datalake API; the account had no credits today, so the demo runs on canned evidence. One env var switches it on." Short, then move on.
- **Why not a vector database?** Policy and orders are structured JSON; the only similarity search is over video frames.
- **What stops the model over-refunding?** Limits live in the refund service and are checked again there; the agent has no shell, no browser, no keys.
- **How do you know it works after a prompt change?** The golden set and gate run in CI; a regression blocks the deploy.

## If something breaks
- Card never appears: Refund Desk → Reset demo data → file again. Second failure → play `assets/demo-backup.mp4`.
- Twin not there after 40 s: keep going; it is a bonus. Check `npm run render:service` before the next run.
- "Offline" in the top bar: `npm run dev:local` in a terminal, reload.
