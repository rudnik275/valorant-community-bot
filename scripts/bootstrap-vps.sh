#!/usr/bin/env bash
# bootstrap-vps.sh — idempotent provisioning for fresh Ubuntu 24.04 LTS ARM (Hetzner CAX11)
# Usage: sudo bash bootstrap-vps.sh [OWNER_USER]
# If OWNER_USER is not provided, derives from SUDO_USER or falls back to USER.
set -euo pipefail

OWNER_USER="${1:-${SUDO_USER:-$USER}}"

echo "==> [1/8] apt update + upgrade + install base packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates jq ufw unattended-upgrades

echo "==> [2/8] Configure UFW"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

echo "==> [3/8] Enable unattended security upgrades"
dpkg-reconfigure -p low unattended-upgrades

echo "==> [4/8] Install Docker (idempotent)"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    Docker already installed, skipping."
fi

echo "==> [5/8] Create /opt directory layout"
install -d -o "${OWNER_USER}" -g "${OWNER_USER}" /opt/_infra/cloudflared
install -d -o "${OWNER_USER}" -g "${OWNER_USER}" /opt/_infra/watchtower
install -d -o "${OWNER_USER}" -g "${OWNER_USER}" /opt/valorant-bot/data

echo "==> [6/8] Create Docker network infra-net (idempotent)"
docker network create infra-net 2>/dev/null || true

echo "==> [7/8] Install systemd docker-prune timer (weekly)"
cat > /etc/systemd/system/docker-prune.service <<'SERVICE'
[Unit]
Description=Weekly Docker system prune
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker system prune -af
SERVICE

cat > /etc/systemd/system/docker-prune.timer <<'TIMER'
[Unit]
Description=Run docker-prune weekly

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now docker-prune.timer

echo "==> [8/8] Done!"
echo "✓ VPS bootstrapped. Next: scp creds, docker compose up в /opt/_infra/* и /opt/valorant-bot/"
