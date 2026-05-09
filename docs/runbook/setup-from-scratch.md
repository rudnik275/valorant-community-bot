# Setup from Scratch

Complete guide for bootstrapping the valorant-community-bot from zero — no existing server, tunnel, or bot token.

---

## 1. One-time setup (owner, manual)

Do these steps **once**. They create long-lived resources (Cloudflare tunnel, Telegram bot, S3 bucket, etc.) that survive server replacements. Skip any step that is already done.

### 1.1 Hetzner account and billing

1. Create an account at [hetzner.com](https://www.hetzner.com/) if you don't have one.
2. Go to **Cloud → Billing** and add a payment method.
3. Optionally create an **SSH key** in the Hetzner Console (**Security → SSH Keys → Add SSH Key**) and upload your public key. You will select this key when ordering the server.

---

### 1.2 Domain in Cloudflare

You need a domain managed by Cloudflare (so Cloudflare Tunnel can create CNAME records automatically).

- If you already have a domain on Cloudflare: no action needed.
- If you need to add a domain: [Add a site to Cloudflare](https://developers.cloudflare.com/fundamentals/setup/account-setup/add-site/).

---

### 1.3 Create Cloudflare Tunnel

Run locally (requires `cloudflared` installed — `brew install cloudflare/cloudflare/cloudflared` on macOS):

```bash
cloudflared tunnel create valorant-bot
```

Output includes:
- **Tunnel ID (UUID)** — save this, you need it in `config.yml`.
- **Credentials file path** — e.g. `~/.cloudflared/<tunnel-uuid>.json`. This is `creds.json`.

Save the `creds.json` file:

- **Phase 0–3 (MVP):** Copy to a safe offline location (encrypted local file, NAS). You will `scp` it to the VPS during bootstrap.
- **Phase 4:** Store in 1Password: `op item create --vault valorant-bot --title cf-tunnel --field "creds-json[password]=$(cat ~/.cloudflared/<tunnel-uuid>.json)"`.

> **creds.json** contains a private key — treat it like a password. Never paste its contents into a terminal or chat.

---

### 1.4 Create Cloudflare DNS record for the tunnel

```bash
cloudflared tunnel route dns valorant-bot bot.<your-domain>
```

This creates a `CNAME` record: `bot.<your-domain>` → `<tunnel-uuid>.cfargotunnel.com`.

Verify in Cloudflare Dashboard → **DNS** that the record exists (orange cloud = proxied, which is correct).

---

### 1.5 Hetzner Object Storage (Litestream backups)

1. Log in to [Hetzner Console](https://console.hetzner.cloud/).
2. Go to **Object Storage** → **Create Bucket**.
   - Bucket name: `valorant-bot-litestream`
   - Region: choose closest (e.g. `fsn1` for Falkenstein).
3. Go to **S3 Credentials** → **Generate Credentials**.
   - Save the Access Key ID and Secret Access Key immediately (shown only once).
4. Record the following — you will add them to `/opt/valorant-bot/.env` on the VPS:

```
LITESTREAM_S3_BUCKET=valorant-bot-litestream
LITESTREAM_S3_ACCESS_KEY_ID=<your-access-key-id>
LITESTREAM_S3_SECRET_ACCESS_KEY=<your-secret-access-key>
LITESTREAM_S3_ENDPOINT=https://valorant-bot-litestream.<region>.your-objectstorage.com
```

Replace `<region>` with the actual region slug (e.g. `fsn1`).

> **Security:** These are placeholder/dev credentials in Phase 0–3. Real prod credentials will be rotated to 1Password in Phase 4 (see `docs/runbook/secrets-rotation.md`, issue #21).

See also `docs/runbook/litestream-restore.md` for restore procedure.

---

### 1.6 Create the Telegram bot via @BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Follow prompts: set display name and username (must end in `bot`, e.g. `valorant_community_bot`).
4. BotFather sends the **bot token** — a string like `123456789:AAF...`.
5. Save the token:
   - **Phase 0–3 (MVP):** Put it directly in your local `.env` as `TELEGRAM_BOT_TOKEN=<token>`.
   - **Phase 4:** Store in 1Password: `op://valorant-bot/telegram-bot/token`.

> Never commit the real bot token to Git. The `.env.example` file uses an empty placeholder.

---

### 1.7 Disable bot privacy mode

In @BotFather:

```
/mybots → [select your bot] → Bot Settings → Group Privacy → Turn off
```

Or send `/setprivacy`, select the bot, choose **Disable**.

**This is mandatory.** Without disabling privacy mode the bot cannot read group messages, which breaks the `last_message_at` listener and scanner.

---

### 1.8 Create a test group and get the chat ID

1. Create a private Telegram group (e.g. "Valorant Bot Test").
2. Add your bot to the group.
3. Make the bot an **admin**: group settings → Administrators → Add Administrator → select the bot → enable **Promote members** right (required for pinning and future admin actions).
4. Send any message in the group to trigger the bot's first update.
5. Check bot logs for the incoming `chat.id` value:

```bash
docker logs valorant-bot-app 2>&1 | grep -i "chat_id\|chat\.id"
```

Alternatively, use the Telegram Bot API directly while the bot is running:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Look for `"chat":{"id":<number>}` — that number is the `TELEGRAM_ALLOWED_CHAT_IDS` value.

6. Save the chat ID:

```
TELEGRAM_ALLOWED_CHAT_IDS=-100xxxxxxxxxx
```

---

### 1.9 Set the bot menu button

In @BotFather:

```
/setmenubutton → [select your bot] → Web App → enter URL: https://bot.<your-domain>
```

Or via API (after the bot is running):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setChatMenuButton" -H "Content-Type: application/json" -d '{"menu_button":{"type":"web_app","text":"Open","web_app":{"url":"https://bot.<your-domain>"}}}'
```

This adds the webapp button to the bot's menu in the test group.

---

### 1.10 Healthchecks.io

Create an account at [healthchecks.io](https://healthchecks.io) and add three checks:

#### Check 1: scanner-tick

| Field | Value |
|-------|-------|
| Name | `valorant-bot-scanner-tick` |
| Schedule | Every 30 minutes |
| Grace period | 35 minutes |

Copy the ping URL → `HEALTHCHECK_SCANNER_URL=https://hc-ping.com/<check-uuid>`

#### Check 2: weekly-digest

| Field | Value |
|-------|-------|
| Name | `valorant-bot-weekly-digest` |
| Schedule | Every 1 week |
| Grace period | 25 hours |

Copy the ping URL → `HEALTHCHECK_DIGEST_URL=https://hc-ping.com/<check-uuid>`

#### Check 3: deploy

| Field | Value |
|-------|-------|
| Name | `valorant-bot-deploy` |
| Schedule | on-demand (cron: `0 0 1 1 *` — never fires automatically) |
| Grace period | 7 days |

The deploy workflow pings this check after every successful deploy. If no deploy happens in 7 days you get an alert. Configure the ping URL in GitHub Actions `manual-deploy.yml` or `ci.yml` (see `.github/workflows/`).

Add all three variables to `/opt/valorant-bot/.env` on the VPS.

---

### 1.11 GitHub Secrets

Set in repo **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `SSH_PRIVATE_KEY` | Private key whose `.pub` is in `~deploy/.ssh/authorized_keys` on the VPS |
| `SSH_HOST` | Hetzner CAX11 IPv4 address |
| `SSH_USER` | `deploy` |
| `GHCR_TOKEN` | Not required — we use `GITHUB_TOKEN` with `permissions: packages: write` |

Test SSH connectivity after setup:

```bash
ssh -i ~/.ssh/id_ed25519 deploy@<VPS_IP> 'docker ps'
```

> **App secrets (bot token, S3 keys, etc.) live in `/opt/valorant-bot/.env` on the VPS**, not in GitHub Secrets. They are copied to the server during bootstrap (see below).

---

## 2. Bootstrap VPS

Spin up the server and bring the app online. This is the same sequence as the disaster recovery procedure.

**Follow [`docs/runbook/disaster-recovery.md`](disaster-recovery.md) steps 1–15.**

The only difference from DR is step 13 (Litestream restore):
- **First-time setup:** skip step 13 — there is no backup yet. The app creates a fresh empty database on first start.
- **DR (replacing a dead server):** run step 13 to restore from the most recent Litestream snapshot.

---

## 3. First deploy

Once the VPS is running:

1. Push a commit to `master`:

```bash
git push origin master
```

2. GitHub Actions (`ci.yml` / `manual-deploy.yml`) builds the Docker image, pushes it to GHCR, and deploys via SSH to the VPS.

3. Verify:

```bash
curl -f https://bot.<your-domain>/healthz
```

Expected: `200 OK`.

Check deploy logs in **GitHub → Actions** for the run status.

---

## 4. Soft-launch sequence

Use this when you are ready to enable the bot in the **real** community group (not just the test group).

### Step 4.1 — Add the real group and promote the bot

In the real Telegram group: add the bot as a member, then promote to admin with **Promote members** right.

### Step 4.2 — Add real group to allowed chat IDs

Get the real group's chat ID (same method as 1.8). Then update `.env` on the VPS:

```bash
ssh deploy@<VPS_IP> "sed -i 's|TELEGRAM_ALLOWED_CHAT_IDS=.*|TELEGRAM_ALLOWED_CHAT_IDS=<test-chat-id>,<real-chat-id>|' /opt/valorant-bot/.env && cd /opt/valorant-bot && docker compose up -d --no-deps app"
```

### Step 4.3 — Set staged-rollout silent period

Prevent the bot from posting events immediately (give members time to get used to it):

```bash
ssh deploy@<VPS_IP> "sed -i 's|EVENTS_PUBLISHING_ENABLED_AFTER=.*|EVENTS_PUBLISHING_ENABLED_AFTER=2026-05-16T12:00:00+03:00|' /opt/valorant-bot/.env && cd /opt/valorant-bot && docker compose up -d --no-deps app"
```

Replace the date with `now + 7 days` in ISO 8601 format with your timezone offset.

Events occurring before this date are stored in the database with `status='silent'` and are not sent to the group.

### Step 4.4 — Share the bot link

Post the bot's Telegram link in the real group so members can find it:

```
https://t.me/<bot-username>
```

### Step 4.5 — After 1 week: enable publishing

After the silent period ends, clear `EVENTS_PUBLISHING_ENABLED_AFTER` so publishing activates:

```bash
ssh deploy@<VPS_IP> "sed -i 's|EVENTS_PUBLISHING_ENABLED_AFTER=.*|EVENTS_PUBLISHING_ENABLED_AFTER=|' /opt/valorant-bot/.env && cd /opt/valorant-bot && docker compose up -d --no-deps app"
```

See [`docs/runbook/staged-rollout-checklist.md`](staged-rollout-checklist.md) for the full staged-rollout procedure (issue #20).

---

## 5. Privacy mode reminder

After `/newbot`, always run:

```
@BotFather → /setprivacy → [select bot] → Disable
```

**This is mandatory.** Privacy mode blocks the bot from reading messages in groups, which breaks:
- `last_message_at` listener (used for inactivity detection)
- The main scanner listener

If you forget this step, the bot joins groups successfully but silently ignores all messages.

---

## 6. Cross-references

| Document | Purpose |
|----------|---------|
| [`disaster-recovery.md`](disaster-recovery.md) | Replace a dead VPS in <30 minutes (RTO 30 min, RPO ~10s) |
| [`litestream-restore.md`](litestream-restore.md) | Full DB restore procedure from Hetzner Object Storage |
| [`staged-rollout-checklist.md`](staged-rollout-checklist.md) | Soft-launch checklist and silent-period management (issue #20) |
| [`secrets-rotation.md`](secrets-rotation.md) | Phase 4: rotate all secrets from plaintext to 1Password (issue #21) |
