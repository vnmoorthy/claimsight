#!/bin/bash
# One command for the moment the Memories.ai balance is positive:
#   1) index the demo clips (real ids into data/demo_evidence.json, collection id into .env)
#   2) restart the local backend in real-evidence mode (MEMORIES_STUB=0) with the render worker + AgentX
#   3) run the Synthetic Evidence Lab against the real detector and push the lab run to AgentX
# Usage: bash scripts/go-live-memories.sh [lab clip count, default 24]
set -euo pipefail
cd "$(dirname "$0")/.."
COUNT="${1:-24}"
export $(grep -E '^(MEMORIES_API_KEY|AGENTX_API_KEY|AGENTX_OTLP_URL|AI_GATEWAY_API_KEY|AI_GATEWAY_BASE_URL|AI_GATEWAY_MODEL)=' .env | sed 's/ *#.*//' | xargs)
export MEMORIES_STUB=0 AGENTX_API_BASE_URL="${AGENTX_API_BASE_URL:-http://localhost:4700/api/v1}"
B="https://api.memories.ai/serve/datalake/v1"
bal=$(curl -s -m 15 "$B/usage/balance" -H "Authorization: $MEMORIES_API_KEY")
echo "Memories.ai balance: $bal"
echo "$bal" | grep -q '"balance_usd":0[,}]' && { echo "Balance is 0 — top up the account that owns this key, then re-run."; exit 2; }

echo "== 1/3 index demo clips =="
npx tsx scripts/index-demo-clips.ts --write | tee /tmp/index-clips.log
COL=$(grep -oE 'MEMORIES_CLAIMS_COLLECTION=[A-Za-z0-9_-]+' /tmp/index-clips.log | tail -1 | cut -d= -f2)
if [ -n "$COL" ]; then
  grep -q '^MEMORIES_CLAIMS_COLLECTION=' .env && sed -i '' -E "s|^MEMORIES_CLAIMS_COLLECTION=.*|MEMORIES_CLAIMS_COLLECTION=$COL|" .env || echo "MEMORIES_CLAIMS_COLLECTION=$COL" >> .env
  sed -i '' -E 's|^MEMORIES_STUB=.*|MEMORIES_STUB=0|' .env
  export MEMORIES_CLAIMS_COLLECTION="$COL"
  echo "collection: $COL (saved to .env)"
fi

echo "== 2/3 restart backend in real-evidence mode =="
OLD=$(lsof -nP -tiTCP:8088 -sTCP:LISTEN || true); [ -n "$OLD" ] && kill $OLD && sleep 1
( MEMORIES_STUB=0 MEMORIES_API_KEY="$MEMORIES_API_KEY" MEMORIES_CLAIMS_COLLECTION="${MEMORIES_CLAIMS_COLLECTION:-}" \
  TWIN_RENDER_URL=http://localhost:8090 AGENTX_OTLP_URL="${AGENTX_OTLP_URL:-http://localhost:4700/api/v1/otel/v1/traces}" AGENTX_API_KEY="${AGENTX_API_KEY:-}" \
  AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY:-}" AI_GATEWAY_BASE_URL="${AI_GATEWAY_BASE_URL:-}" AI_GATEWAY_MODEL="${AI_GATEWAY_MODEL:-}" \
  nohup npm run dev:local > /tmp/harness.log 2>&1 & )
for i in $(seq 1 30); do grep -q listening /tmp/harness.log && break; sleep 1; done
curl -s http://localhost:8088/stats | grep -oE '"backend_label":"[^"]+"|"mode_label":"[^"]+"' | tr '\n' ' '; echo
curl -s -o /dev/null -w "render worker: %{http_code}\n" http://localhost:8090/health || echo "render worker not running: npm run render:service"

echo "== 3/3 synthetic evidence lab (real detector, $COUNT clips) =="
npm run lab -- --count "$COUNT" --seed 7 | tail -25
if [ -n "${AGENTX_API_KEY:-}" ] && [ -x .venv/bin/python ]; then .venv/bin/python eval/lab_eval.py public/lab/results.json | tail -8; fi
echo "Done. Open the Lab tab and file A1042 (real evidence ids are in data/demo_evidence.json)."
