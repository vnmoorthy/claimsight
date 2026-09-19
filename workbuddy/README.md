# ClaimSight × WorkBuddy — Refund Desk

The `refund-desk` skill lets a manager clear ClaimSight's human-review queue from WorkBuddy:
list `pending_review` claims, approve/deny each, and post a summary to Slack. A second recipe
turns yesterday's claims into a `.docx` digest every morning at 9:00.

```
workbuddy/
  refund-desk/
    SKILL.md      # Trigger / Instructions / Example (the prompt WorkBuddy follows)
    config.yaml   # manifest: triggers, env (CLAIMSIGHT_URL), tools, Slack channel, automation
  README.md       # this file
```

The skill only needs the ClaimSight backend to be reachable (`CLAIMSIGHT_URL`). It uses three
endpoints from `SPEC.md` section 2: `GET /claims?status=pending_review`, `POST /claims/decision`
and `GET /stats`. No API key is involved.

## 1. Add the skill in WorkBuddy

1. Open WorkBuddy → **Settings** → **Skills** (in some builds: the **Skills** panel in the sidebar).
2. Click **Add skill** → **From folder** and pick `claimsight/workbuddy/refund-desk`
   (the folder that contains `SKILL.md` + `config.yaml`). If your build only accepts a single
   file, paste the contents of `SKILL.md`; the manifest values are duplicated inside it.
3. Set the skill's environment value **`CLAIMSIGHT_URL`**:
   - local dev: `http://localhost:8088` (what `edgeone makers dev` prints)
   - deployed: your Makers project URL, e.g. `https://claimsight.edgeone.app`
   Optionally set `CLAIMSIGHT_UI_URL` if the web UI lives on a different host.
4. Enable the skill and test it: type **"refund desk"**. You should see the numbered list of
   pending claims (or "nothing is waiting for review").

Menu names can differ slightly between WorkBuddy versions; the skill itself is plain Markdown +
YAML and does not depend on a specific importer.

To produce pending claims for a demo, send a claim for order **A1050** (headphones, $129 → above
the $75 limit → escalated) or **A1043** (the fraud twin) through the ClaimSight chat first.

## 2. Optional: add ClaimSight as an MCP server

The skill works over plain HTTP, so this is optional. If the backend exposes an MCP endpoint
(for example `claimsight` with tools `list_claims`, `decide_claim`, `get_stats`), register it so
WorkBuddy can call the tools directly instead of composing HTTP requests:

1. WorkBuddy → **Settings** → **MCP servers** (or **Integrations → MCP**) → **Add server**.
2. Name: `claimsight`. Transport: HTTP/SSE. URL: `{CLAIMSIGHT_URL}/mcp` (or the command the
   backend README documents for stdio).
3. Save, then flip `mcp.enabled: true` in `refund-desk/config.yaml`. The instructions in
   `SKILL.md` map 1:1: `list_claims(status="pending_review")` ↔ `GET /claims?status=pending_review`,
   `decide_claim(claim_id, decision, note)` ↔ `POST /claims/decision`, `get_stats()` ↔ `GET /stats`.

If no MCP server is exposed, leave `mcp.enabled: false` — nothing else changes.

## 3. Connect Slack

1. WorkBuddy → **Settings** → **Integrations** → **Slack** → **Connect**, authorize the workspace
   in the browser window that opens.
2. Create (or pick) the channel **`#refund-desk`** and invite the WorkBuddy app to it
   (`/invite @WorkBuddy` inside the channel).
3. In `refund-desk/config.yaml`, `slack.channel` is `#refund-desk`; change it if you use another
   channel. The skill posts the summary block shown in `SKILL.md` ("Slack summary format").
4. Test: run "refund desk", approve or deny one claim, and check the channel for the post.

Note: ClaimSight's own escalation webhook (`SLACK_WEBHOOK_URL` in the backend `.env`) posts the
*incoming* escalations ("Reply in WorkBuddy Refund Desk or open <UI>/desk"); this skill posts the
*outgoing* decisions. Pointing both at `#refund-desk` gives one channel with the full story.

## 4. Daily Automation recipe

WorkBuddy → **Automations** → **New automation**:

- **Name:** Daily 9:00 claims digest
- **Schedule:** every day at 09:00 (cron `0 9 * * *`; weekdays only: `0 9 * * 1-5`)
- **Skill:** refund-desk
- **Output:** document (.docx) + Slack post to `#refund-desk`
- **Prompt** (paste as-is):

> Summarize yesterday's ClaimSight claims into a .docx: auto-approval rate, refunded $, fraud flags,
> top damage types. Call `GET {CLAIMSIGHT_URL}/stats` and `GET {CLAIMSIGHT_URL}/claims`, keep the
> claims whose `created_at` falls on yesterday's date, and compute: auto-approval rate (claims decided
> by the agent with action refund or replacement ÷ all claims), refunded $ (sum of `decision.amount`
> where action is refund and status is auto_approved or approved), fraud flags (claims with at least
> one `fraud.matches` entry — list the matched customer ids), and the top damage types (count the
> `damage_assessment` values, top 5). Add a table of every escalated/denied claim with its reason and
> policy clauses. Save it as `ClaimSight-daily-<YYYY-MM-DD>.docx`, then post the four headline numbers
> and the file to #refund-desk. If there were no claims yesterday, say so in one line and skip the document.

The same text lives under `automations:` in `refund-desk/config.yaml` for builds that import
automations from the manifest.

## Troubleshooting

- **"Refund Desk: nothing is waiting for review" but the web desk shows claims** — the skill's
  `CLAIMSIGHT_URL` points at a different backend than the UI. Compare with the URL in the browser.
- **HTTP 404 on `/claims`** — the backend is the template's `chat` starter without the ClaimSight
  cloud functions; deploy the `claims` agent + cloud functions first.
- **Approve returns no `txn_id`** — the server refused the refund (amount above the order total, or
  the human-approval header missing). Check the backend logs for `/refund`.
- **Nothing posted to Slack** — the WorkBuddy app is not in the channel; re-run `/invite @WorkBuddy`.
