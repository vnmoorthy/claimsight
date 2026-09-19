# ClaimSight — 3-minute stage storyboard

Timing is for a 3:00 slot with the deck on screen and the app in a second window. Beats are numbered by slide.

| Time | Slide | You say | You do |
|---|---|---|---|
| 0:00 | 1 Cover | "Hi, we're ClaimSight. Refunds with receipts." | Stand still. One breath. |
| 0:08 | 2 Problem | "Return fraud cost US retailers 101 billion dollars in 2023. Every refund still needs a human to squint at a photo, guess, and either overpay or escalate everything. And the same cracked mug gets filmed for three claims from three accounts, and no queue can see that." | Point at the three tiles. |
| 0:30 | 3 What it is | "ClaimSight is an after-sales teammate. It watches the customer's evidence video, applies your policy, executes the refund itself, and pulls a human in only when policy says so." | Advance. |
| 0:40 | 4 The loop | "Data, intelligence, experience, execution, transaction. One loop, and we actually reach the last step: a ledger entry, not a chat answer." | Trace the five cards with your hand. |
| 0:55 | 5 Live demo | "Let me show you." | Switch to the app, Chat tab. Order A1042 is prefilled. |
| 1:00 | app | "A customer says their mug arrived chipped and films it." | Pick the demo clip "Chipped mug — A1042", press File claim. |
| 1:05 | app | Narrate the trace as the lamps light: "Order found. Policy loaded. Memories.ai sees a white ceramic mug with a chip on the rim at three seconds. No matching footage elsewhere. Twenty-four dollars is under the seventy-five dollar auto-approve limit, so it executes the refund. Transaction id, done. And Blender is already rendering the receipt: a 3D twin of the mug with the chip marked where Memories.ai saw it." | Point at the Decision trace panel, then the Decision Card; the Damage Twin video appears in the card about 25 seconds after filing. |
| 1:35 | app | "Now a second customer, different account, same mug." | Order A1043, demo clip "Same mug footage, other account". File claim. |
| 1:45 | app | "Image search across every prior claim finds the twin at ninety-three percent similarity. The claim is frozen and escalated. The manager gets it in Slack through the WorkBuddy Refund Desk, and here in the desk." | Switch to Refund Desk, open the pending claim, press Deny claim. |
| 2:05 | 6 Production | "This is not a demo agent. Thirty golden claims, a policy judge, a deploy gate that fails on regression, PII and secrets monitors on every reply, and a trace per claim in AgentX. Refund limits are enforced by the service, not the prompt, so the model cannot exceed policy even if asked." | Show the AgentX run if time allows, otherwise stay on the slide. |
| 2:30 | 7 Stack | "EdgeOne Makers runs the agent and holds the data. Memories.ai is the eyes. AgentX is the gate. WorkBuddy is the human desk. VeloDB is the dashboard. AWS credits take it to production." | Advance. |
| 2:45 | 8 Why it wins / 9 Next | "Returns fraud is a hundred-billion-dollar problem and every marketplace has a returns desk. Next thirty days: one pilot, measure auto-approval rate and fraud catches." | Advance. |
| 2:55 | 10 Close | "Data to transaction, in one loop. Thank you." | Stop. Leave time for one question. |

## If something breaks
- Gateway slow or down: the app runs the deterministic policy engine automatically; the trace and card look identical. Say nothing.
- Twin video not there after 40 s: keep talking; it is a bonus, not the core. Check `npm run render:service` is running before the next run.
- Backend unreachable: switch to the screen recording (assets/demo-backup.mp4) and narrate over it.
- Refund Desk empty: press Refresh; if still empty, show the claim card in the chat and skip the desk.

## Likely judge questions
- "What if the video is fake or reused?" → Image search across prior claims, plus every escalation is human-reviewed; the fraud twin catch is the demo.
- "How do you keep the model from over-refunding?" → Limits live in the refund service and are checked again there; the model has no key and no shell.
- "Does it need a vector database?" → No. Policy and orders are structured JSON in Makers storage; the only similarity search is Memories.ai's, over video.
- "How do you know it works after a prompt change?" → The AgentX golden set and gate run in CI; a regression blocks the deploy.
