# Setup from Scratch

> **Note:** This file is the skeleton — issue #19 (dr-runbook) will fill in the full setup-from-scratch flow including DR steps.

---

## Prerequisites

<!-- TODO: filled by #19 — ordering a Hetzner CAX11, SSH key setup -->

## BotFather Setup

<!-- TODO: filled by #19 — create Telegram bot, obtain BOT_TOKEN -->

After `/newbot` in BotFather, run `/mybots` → select your bot → **Bot Settings** → **Group Privacy** → **Turn off** (`/setprivacy → Disable`) so the bot receives all group messages (required for the `last_message_at` listener).

## Hetzner CAX11 Ordering

<!-- TODO: filled by #19 — server ordering, SSH access, firewall in Hetzner UI -->

## VPS Bootstrap

Run `scripts/bootstrap-vps.sh` as root on the freshly provisioned Hetzner CAX11:

```
scp scripts/bootstrap-vps.sh root@<VPS_IP>:/tmp/
ssh root@<VPS_IP> bash /tmp/bootstrap-vps.sh
```

## Cloudflare Tunnel Creation

<!-- TODO: filled by #19 — cloudflared tunnel create, creds.json, DNS record in Cloudflare UI -->

## GitHub Secrets

Set in repo Settings → Secrets and variables → Actions → New repository secret:

- `SSH_PRIVATE_KEY` — private key whose `*.pub` is in `~deploy/.ssh/authorized_keys` on the VPS
- `SSH_HOST` — Hetzner CAX11 IP or hostname
- `SSH_USER` — `deploy` (a non-root user in the `docker` group; create via `useradd -m -s /bin/bash deploy && usermod -aG docker deploy`)
- `GHCR_TOKEN` — optional; we use `GITHUB_TOKEN` with `permissions: packages: write` instead, so this is NOT required

Test the SSH connection once manually after setup: `ssh -i ~/.ssh/id_ed25519 deploy@<host> 'docker ps'`.

<!-- TODO: filled by #19 — BOT_TOKEN and other app secrets added to VPS .env, not GH Secrets -->

---

## Healthchecks.io

Create two monitoring checks at [healthchecks.io](https://healthchecks.io):

### 1. scanner-tick

| Field | Value |
|-------|-------|
| Name | `valorant-bot-scanner-tick` |
| Schedule | Every 30 minutes |
| Grace period | 35 minutes |

After creating, copy the ping URL and save it as:

```
HEALTHCHECK_SCANNER_URL=https://hc-ping.com/<check-uuid>
```

### 2. weekly-digest

| Field | Value |
|-------|-------|
| Name | `valorant-bot-weekly-digest` |
| Schedule | Every 1 week |
| Grace period | 25 hours |

After creating, copy the ping URL and save it as:

```
HEALTHCHECK_DIGEST_URL=https://hc-ping.com/<check-uuid>
```

Add both variables to `/opt/valorant-bot/.env` on the VPS.

---

## Hetzner Object Storage

Used for Litestream SQLite backups (configured in issue litestream-backup).

### Steps

1. Log in to [Hetzner Console](https://console.hetzner.cloud/).
2. Go to **Object Storage** → **Create Bucket**.
   - Bucket name: `valorant-bot-litestream`
   - Region: choose closest (e.g. `fsn1` for Falkenstein).
3. Go to **S3 Credentials** → **Generate Credentials**.
   - Save the Access Key ID and Secret Access Key immediately (shown only once).
4. Add the following to `/opt/valorant-bot/.env` on the VPS:

```
LITESTREAM_S3_BUCKET=valorant-bot-litestream
LITESTREAM_S3_ACCESS_KEY_ID=<your-access-key-id>
LITESTREAM_S3_SECRET_ACCESS_KEY=<your-secret-access-key>
LITESTREAM_S3_ENDPOINT=https://valorant-bot-litestream.<region>.your-objectstorage.com
```

Replace `<region>` with the actual region slug (e.g. `fsn1`).

> **Security:** These are placeholder/dev credentials in Phase 0–3. Real prod credentials will be rotated to 1Password in Phase 4 (#21).

---

## Start Services

```
# cloudflared sidecar
scp infra/_compose/cloudflared/docker-compose.yml root@<VPS_IP>:/opt/_infra/cloudflared/
scp infra/_compose/cloudflared/config.yml root@<VPS_IP>:/opt/_infra/cloudflared/
# scp your creds.json separately (see infra/_compose/cloudflared/README.md)
ssh root@<VPS_IP> 'cd /opt/_infra/cloudflared && docker compose up -d'

# watchtower
scp infra/_compose/watchtower/docker-compose.yml root@<VPS_IP>:/opt/_infra/watchtower/
ssh root@<VPS_IP> 'cd /opt/_infra/watchtower && docker compose up -d'

# valorant-bot app
scp infra/valorant-bot/docker-compose.prod.yml root@<VPS_IP>:/opt/valorant-bot/docker-compose.yml
# scp your .env separately
ssh root@<VPS_IP> 'cd /opt/valorant-bot && docker compose up -d'
```

---

## Disaster Recovery

<!-- TODO: filled by #19 — full DR steps: restore from Litestream, re-bootstrap VPS, reconnect tunnel -->
