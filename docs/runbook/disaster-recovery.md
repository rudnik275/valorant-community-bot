# Disaster Recovery Runbook

Procedure for bringing up a replacement Hetzner CAX11 after the primary server is lost.

**RTO target:** 30 minutes from ordering the new server to `curl /healthz` returning 200.
**RPO target:** ~10 seconds (Litestream continuously streams WAL segments to Hetzner Object Storage).

---

## Pre-conditions

Everything in this checklist must be ready **before** a disaster occurs. Verify it during first setup and after every rotation.

| Item | Phase 0–3 (MVP) | Phase 4 (prod-ready) |
|------|-----------------|----------------------|
| SSH key pair | Stored as file on local NAS / machine | `op://valorant-bot/vps-ssh-key` in 1Password |
| Cloudflare tunnel creds.json | Local file from when `cloudflared tunnel create` was run | `op://valorant-bot/cf-tunnel/creds-json` in 1Password |
| Hetzner S3 credentials (access key + secret) | Plaintext in local `.env` copy | `op://valorant-bot/hetzner-s3/access-key` and `.../secret-key` in 1Password |
| Telegram bot token | Plaintext placeholder in local `.env` copy | `op://valorant-bot/telegram-bot/token` in 1Password |
| Henrik API key (if applicable) | Plaintext placeholder in local `.env` copy | `op://valorant-bot/henrik-api/key` in 1Password |
| GitHub repository | `github.com/rudnik275/valorant-community-bot` is accessible | Same |
| Hetzner account | Active with billing configured | Same |
| Cloudflare account | Active, domain configured | Same |

> **Phase 4 note:** Rotate all secrets from plaintext files to 1Password as part of issue #21 (`secrets-rotation.md`). Until then, the operator must have a plaintext `.env` copy in a safe offline location (encrypted disk, NAS, etc.).

---

## Step-by-step

### Step 1 — Order new Hetzner CAX11

1. Log in to [Hetzner Console](https://console.hetzner.cloud/).
2. **Create Server**:
   - Location: **Falkenstein (fsn1)**
   - Image: **Ubuntu 24.04 (ARM64)**
   - Type: **CAX11** (2 vCPU ARM, 4 GB RAM)
   - SSH key: add the public key stored in 1Password (Phase 4) or your local key pair (Phase 0–3)
   - Name: `valorant-bot` (or any name you prefer)
3. Click **Create & Buy Now**.
4. Copy the assigned IPv4 address. You will use `<VPS_IP>` in all commands below.

> Cost: ~€0.005/hour. Billing starts immediately.

---

### Step 2 — SSH as root and install git

Wait ~30 seconds for the server to boot, then:

```bash
ssh root@<VPS_IP> 'apt update && apt install -y git'
```

---

### Step 3 — Clone the repository

```bash
ssh root@<VPS_IP> 'git clone https://github.com/rudnik275/valorant-community-bot.git /tmp/repo && echo "Cloned OK"'
```

---

### Step 4 — Run the bootstrap script

The bootstrap script installs Docker, sets up directories, and configures systemd. See `scripts/bootstrap-vps.sh` for details.

```bash
ssh root@<VPS_IP> 'cd /tmp/repo && bash scripts/bootstrap-vps.sh'
```

Expected: script exits 0, Docker daemon is running.

```bash
ssh root@<VPS_IP> 'docker info | grep "Server Version"'
```

---

### Step 5 — Create the `deploy` user

```bash
ssh root@<VPS_IP> 'useradd -m -s /bin/bash -G docker deploy && mkdir -p /home/deploy/.ssh && cp /root/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys'
```

Verify SSH access with the deploy user:

```bash
ssh deploy@<VPS_IP> 'docker ps'
```

---

### Step 6 — Copy compose templates

```bash
scp -r infra/_compose/cloudflared deploy@<VPS_IP>:/opt/_infra/
scp -r infra/_compose/watchtower deploy@<VPS_IP>:/opt/_infra/
```

---

### Step 7 — Restore Cloudflare tunnel credentials

The tunnel was created once (during first setup). The `creds.json` file must be copied to the new VPS so the **same** tunnel (and DNS record) continues to work without any Cloudflare configuration changes.

**Phase 0–3 (local file):**

```bash
scp /path/to/local/creds.json deploy@<VPS_IP>:/opt/_infra/cloudflared/
```

**Phase 4 (from 1Password):**

```bash
op read "op://valorant-bot/cf-tunnel/creds-json" > /tmp/creds.json && scp /tmp/creds.json deploy@<VPS_IP>:/opt/_infra/cloudflared/ && rm /tmp/creds.json
```

> Never paste or print the `creds.json` contents into the terminal — it contains a private key. Write to a tempfile and scp it.

---

### Step 8 — Configure Cloudflare tunnel

The template in `infra/_compose/cloudflared/` contains placeholder values. Fill in your tunnel UUID and public hostname:

```bash
ssh deploy@<VPS_IP> "sed -i 's|<TUNNEL_UUID>|YOUR_TUNNEL_UUID|g; s|<CF_HOSTNAME>|bot.yourdomain.com|g' /opt/_infra/cloudflared/config.yml"
```

Verify the file looks correct:

```bash
ssh deploy@<VPS_IP> 'cat /opt/_infra/cloudflared/config.yml'
```

---

### Step 9 — Start Cloudflare tunnel

```bash
ssh deploy@<VPS_IP> 'cd /opt/_infra/cloudflared && docker compose up -d'
```

Check the tunnel is connected:

```bash
ssh deploy@<VPS_IP> 'docker logs cloudflared 2>&1 | tail -20'
```

Expected: `connection registered connIndex=0` or similar (no `ERR` lines).

---

### Step 10 — Start Watchtower

Watchtower watches GHCR for new image tags and performs rolling updates automatically.

```bash
ssh deploy@<VPS_IP> 'cd /opt/_infra/watchtower && docker compose up -d'
```

---

### Step 11 — Copy app compose files

```bash
ssh deploy@<VPS_IP> 'mkdir -p /opt/valorant-bot'
scp infra/valorant-bot/docker-compose.prod.yml deploy@<VPS_IP>:/opt/valorant-bot/docker-compose.yml
scp infra/valorant-bot/litestream.yml deploy@<VPS_IP>:/opt/valorant-bot/
```

---

### Step 12 — Create the `.env` file on the VPS

> **Warning:** Treat `.env` like a private key. Never print it to the terminal.

**Phase 0–3 (scp local copy):**

```bash
scp /path/to/local/.env deploy@<VPS_IP>:/opt/valorant-bot/.env
ssh deploy@<VPS_IP> 'chmod 600 /opt/valorant-bot/.env'
```

**Phase 4 (inject from 1Password then scp):**

```bash
op inject -i .env.1password -o /tmp/.env.injected && scp /tmp/.env.injected deploy@<VPS_IP>:/opt/valorant-bot/.env && rm /tmp/.env.injected && ssh deploy@<VPS_IP> 'chmod 600 /opt/valorant-bot/.env'
```

See `.env.example` in the repo root for the full list of required variables.

---

### Step 13 — Restore the database from Litestream backup

> **Important:** Do this **before** starting the app container.

The restore script is bundled inside the app container image. Run it via Docker:

```bash
ssh deploy@<VPS_IP> 'cd /opt/valorant-bot && docker compose run --rm app bash scripts/litestream-restore.sh'
```

For full details on what the script does, expected output, and troubleshooting see [`docs/runbook/litestream-restore.md`](litestream-restore.md).

If no replica exists yet (first-ever deploy), the script exits cleanly — proceed to step 14.

---

### Step 14 — Start the app

```bash
ssh deploy@<VPS_IP> 'cd /opt/valorant-bot && docker compose pull && docker compose up -d'
```

Watch logs for startup errors:

```bash
ssh deploy@<VPS_IP> 'docker logs -f valorant-bot-app 2>&1 | head -50'
```

Expected: no `ERROR` lines, bot sends startup message or logs `polling started`.

---

### Step 15 — Verify the healthcheck endpoint

```bash
curl -f https://bot.<your-domain>/healthz
```

Expected response: `200 OK` with body `{"status":"ok"}` (or similar).

Also check Docker container state:

```bash
ssh deploy@<VPS_IP> 'docker compose -f /opt/valorant-bot/docker-compose.yml ps'
```

All services should be `Up`.

---

### Step 16 — DNS / Cloudflare routing

No DNS changes are required when replacing a Hetzner server.

The Cloudflare Tunnel is identified by its UUID (not by the VPS IP). The DNS record for `bot.<your-domain>` is a `CNAME` pointing to `<tunnel-uuid>.cfargotunnel.com`. As long as the same `creds.json` is used (step 7), the tunnel reconnects and traffic routes to the new VPS automatically.

If you accidentally created a **new** tunnel with a new UUID, you must run `cloudflared tunnel route dns <new-tunnel-name> bot.<your-domain>` locally to update the CNAME — but this should not happen during DR (you reuse the existing tunnel creds).

---

### Step 17 — Restore staged-rollout state

Check what `EVENTS_PUBLISHING_ENABLED_AFTER` was set to before the disaster (look at the old server's `.env` backup or your local copy).

| Previous state | Action |
|----------------|--------|
| Env var was empty (publishing active) | Leave empty — no action needed |
| Env var was set to a future date (staged rollout in progress) | Restore the original date: `ssh deploy@<VPS_IP> "sed -i 's|EVENTS_PUBLISHING_ENABLED_AFTER=.*|EVENTS_PUBLISHING_ENABLED_AFTER=<original-date>|' /opt/valorant-bot/.env" && ssh deploy@<VPS_IP> 'cd /opt/valorant-bot && docker compose up -d --no-deps app'` |

See [`docs/runbook/staged-rollout-checklist.md`](staged-rollout-checklist.md) for the full staged-rollout procedure (created in issue #20).

---

## Troubleshooting

### Cloudflared cannot connect

**Symptom:** `docker logs cloudflared` shows repeated `ERR` or `unable to reach the edge` messages.

- Verify `creds.json` is in `/opt/_infra/cloudflared/` and is not empty.
- Verify `config.yml` has the correct tunnel UUID (no angle-bracket placeholders remaining).
- Confirm the Hetzner firewall allows outbound 443/TCP (it does by default).
- Check Cloudflare Zero Trust dashboard: **Networks → Tunnels** — the tunnel should show as `Active` within ~60 seconds.

### Litestream restore fails

**Symptom:** Script exits with error or `integrity_check` fails.

See the troubleshooting table in [`docs/runbook/litestream-restore.md`](litestream-restore.md).

Quick actions:
- S3 auth error → verify `LITESTREAM_S3_ACCESS_KEY_ID` and `LITESTREAM_S3_SECRET_ACCESS_KEY` in `/opt/valorant-bot/.env`.
- Integrity check fails → restore is corrupt; try an earlier snapshot with `litestream restore -timestamp <earlier-ts>`.
- No replica → fresh deploy, skip restore.

### App starts but bot does not respond in Telegram

- Verify `TELEGRAM_BOT_TOKEN` in `.env` is correct and not the dev/test token.
- Verify `TELEGRAM_ALLOWED_CHAT_IDS` includes the target group chat ID.
- Check `docker logs valorant-bot-app` for `Unauthorized` or `Bad Request` errors.
- Ensure the bot is still an admin with **Promote members** right in the group (permissions survive server replacement).

### `curl /healthz` returns 502 or connection refused

- The app container may still be starting — wait 10–15 seconds and retry.
- Check `docker compose ps` — if `app` is `Restarting`, check logs for startup errors.
- If cloudflared is not yet connected, the HTTPS endpoint is unreachable — fix tunnel first (see above).

---

## Related

- [`litestream-restore.md`](litestream-restore.md) — full DB restore procedure
- [`setup-from-scratch.md`](setup-from-scratch.md) — first-time setup (one-time owner steps)
- [`staged-rollout-checklist.md`](staged-rollout-checklist.md) — staged rollout procedure (issue #20)
- [`secrets-rotation.md`](secrets-rotation.md) — Phase 4 secrets rotation to 1Password (issue #21)
- `scripts/bootstrap-vps.sh` — VPS provisioning script
- `infra/_compose/cloudflared/` — Cloudflare Tunnel compose template
- `infra/_compose/watchtower/` — Watchtower compose template
- `infra/valorant-bot/docker-compose.prod.yml` — app compose file
