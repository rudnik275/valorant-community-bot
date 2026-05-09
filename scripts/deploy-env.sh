#!/usr/bin/env bash
# deploy-env.sh — push a fresh resolved .env to the VPS, then restart app.
#
# Usage:
#   SSH_HOST=<ip> SSH_USER=deploy ./scripts/deploy-env.sh
#
# Pre-requisites:
#   - 1Password CLI (op) installed + signed in (Touch ID).
#   - SSH key configured for SSH_USER@SSH_HOST (1Password SSH agent or IdentityFile).
#   - VPS bootstrapped (scripts/bootstrap-vps.sh) — /opt/valorant-bot/ exists.
#
# What it does:
#   1. `op inject` resolves .env.1password → tempfile (chmod 600).
#   2. `scp` tempfile → /opt/valorant-bot/.env on VPS.
#   3. `ssh` → restarts the app container (`docker compose up -d --no-deps app`).
#   4. Tempfile is deleted on exit.
#
# Notes:
#   - The resolved file is plaintext and contains real secrets, but it never
#     enters AI context — `op inject` writes directly to disk, then we scp it.
#   - Run this whenever .env.1password changes (new secrets, chat-id update,
#     EVENTS_PUBLISHING_ENABLED_AFTER tweak, etc.).

set -euo pipefail

: "${SSH_HOST:?need SSH_HOST (e.g. SSH_HOST=46.62.229.131)}"
: "${SSH_USER:=deploy}"
: "${REMOTE_PATH:=/opt/valorant-bot}"

if ! command -v op >/dev/null 2>&1; then
  echo "✗ 1Password CLI (op) not found." >&2
  exit 1
fi

if [ ! -f .env.1password ]; then
  echo "✗ .env.1password not found in $(pwd)" >&2
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

echo "→ Resolving secrets via op inject..."
op inject -f -i .env.1password -o "$TMP"
chmod 600 "$TMP"

echo "→ Uploading .env to ${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/.env ..."
scp -q "$TMP" "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}/.env"

echo "→ Restarting app container..."
ssh "${SSH_USER}@${SSH_HOST}" "chmod 600 ${REMOTE_PATH}/.env && cd ${REMOTE_PATH} && docker compose up -d --no-deps app"

echo "✓ .env deployed and app restarted."
