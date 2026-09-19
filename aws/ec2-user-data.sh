#!/bin/bash
# ClaimSight production host bootstrap (Amazon Linux 2023 / Ubuntu 22.04, t3.small is enough).
# Installs: the AgentX self-hosted engine (traces, evals, monitors) and a MediaMTX relay that
# Memories.ai can pull live evidence streams from (phone → RTMP → relay → Memories.ai RTSP pull).
# Open inbound: 22 (ssh), 4700 (AgentX, restrict to your IP), 1935 (RTMP in), 8554 (RTSP out to Memories.ai).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null; then
  apt-get update -y && apt-get install -y python3-venv python3-pip docker.io curl
  systemctl enable --now docker
else
  dnf install -y python3 python3-pip docker curl && systemctl enable --now docker
fi

# --- AgentX engine (self-hosted) ---
python3 -m venv /opt/agentx && /opt/agentx/bin/pip install --quiet agentx-python==0.8.28
mkdir -p /var/lib/agentx
cat >/etc/systemd/system/agentx.service <<'UNIT'
[Unit]
Description=AgentX self-hosted engine (ClaimSight traces, evals, monitors)
After=network-online.target
[Service]
Environment=HOME=/var/lib/agentx
Environment=AGENTX_AUTH=enabled
# Optional: enable the LLM judge
# Environment=OPENAI_API_KEY=...
ExecStart=/opt/agentx/bin/agentx-trace-eval -port 4700
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now agentx

# --- MediaMTX relay for live evidence (pull-only Memories.ai streams) ---
docker run -d --name mediamtx --restart unless-stopped -p 1935:1935 -p 8554:8554 -p 8888:8888 bluenviron/mediamtx:latest
# Phone (Larix Broadcaster / OBS): push to  rtmp://<EC2_PUBLIC_IP>/live/cam
# Memories.ai open_stream source_url:     rtsp://<EC2_PUBLIC_IP>:8554/live/cam

echo "ClaimSight host ready: AgentX on :4700, RTMP in on :1935, RTSP out on :8554"
