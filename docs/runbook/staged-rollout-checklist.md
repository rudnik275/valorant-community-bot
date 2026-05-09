# Staged-Rollout Checklist

Quality gate between staging (test-chat only) and soft-launch (real community group).
Walk through every section in order. Do not proceed to the next section until all boxes in the current one are ticked.

**Depends on:** `docs/runbook/disaster-recovery.md`, `docs/runbook/litestream-restore.md`, `docs/runbook/setup-from-scratch.md`.

> **Rule:** Sections 1–7 must all be green before the owner moves to Phase 4 (issue #21 — secrets-rotation-and-1password) and soft-launch.

---

## 1. Окружение для тестирования

Set up the isolated staging environment before running any smoke test.

- [ ] `.env` on VPS has `TELEGRAM_ALLOWED_CHAT_IDS=<test-chat-id>` — **only the test chat**, no real-group ID.
- [ ] Test group exists in Telegram with 2–3 participants (owner + 1–2 volunteer beta testers).
- [ ] Bot is admin in the test group with **Promote members** right.
- [ ] App is running on the VPS: `curl -f https://bot.<your-domain>/healthz` returns `200 OK`.
- [ ] DB file exists on VPS: `docker exec valorant-bot-app ls /app/data/data.db` — no error.
- [ ] Litestream is replicating: `docker exec valorant-bot-litestream litestream replicate -config /etc/litestream.yml ls` — no error.

If this is a fresh VPS, follow [`docs/runbook/setup-from-scratch.md`](setup-from-scratch.md) first.

---

## 2. Functional smoke

Manual or e2e integration tests that verify the bot's core user-facing flows.

### 2.1 Onboarding

- [ ] DM the bot `/start` → tap the Mini App button → Onboarding form opens (not MembersList).
- [ ] Enter a valid Riot ID (name + tag) → submit → response is 200 → success screen shown.
- [ ] Verify DB: user row has `riot_puuid` populated.

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT telegram_id, riot_puuid, riot_name, riot_tag, riot_region, onboarded_at FROM users ORDER BY onboarded_at DESC LIMIT 3;"
  ```

- [ ] Custom title visible in the test group (member card shows `Name#TAG`).

### 2.2 Re-onboarding redirect

- [ ] DM the bot `/start` again (after successful onboarding) → Mini App opens **MembersList** (not the onboarding form).

### 2.3 MembersList

- [ ] Member who wrote in the chat most recently appears at the top after page reload.
- [ ] Member cards do **not** contain K/D ratio, win-rate, or any `lastMessageAt` text label.

### 2.4 Edit settings — opt-out persistence

- [ ] Open Mini App → Settings (edit) → toggle opt-out for chat notifications → close Mini App.
- [ ] Reopen Mini App → Settings → toggle is in the same position (persisted).
- [ ] Verify DB:

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT telegram_id, chat_realtime_disabled FROM opt_outs;"
  ```

### 2.5 Scope-guard — leave on add

- [ ] Create a **third** Telegram group (not in `TELEGRAM_ALLOWED_CHAT_IDS`).
- [ ] Add the bot to that group.
- [ ] Bot leaves within ≤5 seconds.
- [ ] Log contains `unauthorized_invite_left`:

  ```bash
  docker logs valorant-bot-app 2>&1 | grep unauthorized_invite_left | tail -5
  ```

### 2.6 Privacy mode verification

- [ ] Open `@BotFather` → `/mybots` → select bot → **Bot Settings** → **Group Privacy** shows **Disabled**.

---

## 3. Event detection smoke

Verifies that all 11 event types are correctly detected, stored, and rendered.

### 3.1 Live route (optional — requires real activity)

If a beta tester plays a match during the test window:

- [ ] Wait for the scanner tick (runs every 30 min, see Healthchecks.io `valorant-bot-scanner-tick`).
- [ ] Inspect `detected_events`:

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT id, event_type, riot_puuid, status, detected_at FROM detected_events ORDER BY id DESC LIMIT 10;"
  ```

- [ ] Confirm at least one event was detected with `status='pending'`.

### 3.2 Mock route (faster — recommended for CI-like validation)

Apply the mock-events SQL fixture to the **staging DB** (not production):

```bash
# On your local machine — copy fixture to VPS
scp tests/staged-rollout/inject-mock-events.sql deploy@<VPS_IP>:/tmp/inject-mock-events.sql

# On VPS — apply to the live staging DB
docker exec -i valorant-bot-app sqlite3 /app/data/data.db < /tmp/inject-mock-events.sql

# Confirm row counts
docker exec valorant-bot-app sqlite3 /app/data/data.db \
  "SELECT count(*) AS users FROM users; SELECT count(*) AS match_records FROM match_records; SELECT count(*) AS detected_events FROM detected_events;"
```

Expected: all three counts > 0.

- [ ] Counts are non-zero in all three tables.
- [ ] Wait for the publisher tick (≤1 minute after 12:00 Kyiv time) — or restart the app to trigger immediately.
- [ ] All 11 event types rendered without errors:

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT event_type, status FROM detected_events ORDER BY event_type;"
  ```

- [ ] Events with `status='posted'` appeared as messages in the test-chat Telegram group.
- [ ] Ace and clutch events display the correctly escaped Riot nickname (no raw HTML tags).
- [ ] **HTML injection test:** Add a user with `riot_name = '<b>X</b>'` (via `inject-mock-events.sql` or direct SQL insert), trigger a `pending` event, confirm the message in Telegram shows literal `&lt;b&gt;X&lt;/b&gt;` — not bold formatting.

---

## 4. Anti-spam smoke

Verifies quotas: ≤2 chat posts/day, ≤1 post/user/day, max 1 antistat/day, quiet-hours, opt-out.

Use `inject-mock-events.sql` fixture rows or insert directly:

```bash
NOW=$(date +%s%3N)
docker exec valorant-bot-app sqlite3 /app/data/data.db \
  "INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
   VALUES
     ('ace', 'mock-puuid-1', 'anti-spam-test-m1', '{}', $NOW - 3000, 'pending'),
     ('winstreak_9', 'mock-puuid-2', 'anti-spam-test-m2', '{\"streak\":9}', $NOW - 2000, 'pending'),
     ('rank_promo', 'mock-puuid-3', 'anti-spam-test-m3', '{\"from\":\"Silver 1\",\"to\":\"Silver 2\"}', $NOW - 1000, 'pending');"
```

(Requires users with `mock-puuid-1`, `mock-puuid-2`, `mock-puuid-3` in the `users` table — injected by `inject-mock-events.sql`.)

- [ ] After publisher tick: first two events are `status='posted'`, third is `status='digest-only'`.

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT id, event_type, status FROM detected_events WHERE match_id LIKE 'anti-spam-test-%';"
  ```

- [ ] **User quota:** Insert 2 pending events for the same `riot_puuid`. After 2 ticks: first is `posted`, second is `digest-only`.
- [ ] **Antistat quota:** Insert 2 antistat events (`lostrick_9`, `fall_damage_death`) for different users. After 2 ticks: first is `posted`, second is `digest-only`.
- [ ] **Quiet hours:** Temporarily fake pre-noon time by setting `TELEGRAM_TIMEZONE_OVERRIDE` (or wait until before 12:00 Kyiv). Events with `status='pending'` remain `pending` after the tick. Restore normal time and confirm they post afterward.
- [ ] **Opt-out user:** Ensure one mock user has `chat_realtime_disabled=1` in `opt_outs`. Insert a pending event for that user. After tick: event is `status='opted-out'`, no message in chat.

  ```bash
  docker exec valorant-bot-app sqlite3 /app/data/data.db \
    "SELECT telegram_id, chat_realtime_disabled FROM opt_outs;"
  ```

---

## 5. Silent-period smoke

Verifies the `EVENTS_PUBLISHING_ENABLED_AFTER` env gate.

### 5.1 Gate ON — all pending → silent

```bash
# Set gate to far future
ssh deploy@<VPS_IP> "sed -i 's|EVENTS_PUBLISHING_ENABLED_AFTER=.*|EVENTS_PUBLISHING_ENABLED_AFTER=2099-01-01T00:00:00+03:00|' /opt/valorant-bot/.env && cd /opt/valorant-bot && docker compose up -d --no-deps app"

# Insert a pending event
docker exec -i valorant-bot-app sqlite3 /app/data/data.db \
  "INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('ace','mock-puuid-1','silent-test-1','{}','pending');"

# Wait for publisher tick (≤1 min), then verify
docker exec valorant-bot-app sqlite3 /app/data/data.db \
  "SELECT id, event_type, status FROM detected_events WHERE match_id='silent-test-1';"
```

- [ ] Event shows `status='silent'` in the DB.
- [ ] No message appeared in the test-chat Telegram group.

### 5.2 Gate OFF — publishes

```bash
# Clear gate
ssh deploy@<VPS_IP> "sed -i 's|EVENTS_PUBLISHING_ENABLED_AFTER=.*|EVENTS_PUBLISHING_ENABLED_AFTER=|' /opt/valorant-bot/.env && cd /opt/valorant-bot && docker compose up -d --no-deps app"

# Insert a fresh pending event
NOW=$(date +%s%3N)
docker exec valorant-bot-app sqlite3 /app/data/data.db \
  "INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status) VALUES ('ace','mock-puuid-1','silent-test-2','{}', $NOW, 'pending');"
```

- [ ] After the next publisher tick: event is `status='posted'` and message appeared in test-chat.

---

## 6. Weekly digest smoke

Verifies the digest module and opt-out anonymisation.

### 6.1 Manual trigger

```bash
docker exec valorant-bot-app bun run -e "import('./src/server/digest/index.ts').then(m => m.runDigestNow())"
```

(Or the equivalent command for your digest entry-point — check `src/server/digest/`.)

- [ ] A digest message appeared in the test-chat Telegram group.
- [ ] Message contains correct aggregate numbers (kills, wins, etc.).

### 6.2 Opt-out anonymisation

- [ ] Any user with `chat_realtime_disabled=1` in `opt_outs` is **not mentioned by name** in the digest message.
- [ ] If all beta users opted out, the digest still sends without crashing (aggregate numbers may be 0 or omitted).

### 6.3 Healthchecks.io ping

- [ ] After digest trigger, `valorant-bot-weekly-digest` check on Healthchecks.io shows last ping timestamp updated.

---

## 7. DR smoke (hard gate before soft-launch)

**This section is mandatory.** Do not soft-launch until this step is completed on real hardware.

Full procedure: [`docs/runbook/disaster-recovery.md`](disaster-recovery.md).
Restore sub-procedure: [`docs/runbook/litestream-restore.md`](litestream-restore.md).

### 7.1 Preparation

- [ ] A **second** VPS (Hetzner CAX11 or equivalent) is provisioned for this drill. It will be destroyed afterward.
- [ ] The staging DB has at least a few rows in all three tables (users, match_records, detected_events) — the fixture from section 3.2 is sufficient.
- [ ] Litestream has replicated at least one snapshot: verify in Hetzner Object Storage console or via `litestream snapshots`.

### 7.2 DR drill

Follow all steps in `disaster-recovery.md` on the second VPS:

- [ ] New VPS created and SSH key installed.
- [ ] `deploy` user created, Docker installed, repo cloned.
- [ ] `.env` copied from 1Password / secure offline copy.
- [ ] Litestream restore completed per `litestream-restore.md` — data from S3 written to `/app/data/data.db`.
- [ ] Docker Compose started: `docker compose up -d`.
- [ ] `curl -f https://bot.<your-domain>/healthz` returns `200 OK` on the new VPS.

  > You may need to point the Cloudflare tunnel temporarily to the new VPS for this check.

- [ ] `sqlite3 /app/data/data.db 'SELECT count(*) FROM users;'` returns same row count as original VPS.
- [ ] Total time from "VPS created" to "app healthy" ≤ 30 minutes.

### 7.3 Teardown

- [ ] Second VPS destroyed (billing).
- [ ] Cloudflare tunnel pointed back at primary VPS.

---

## 8. Acceptance gate

All of the above must be green before proceeding. This section is the sign-off checklist.

- [ ] **Section 1** — Staging environment: all boxes ticked.
- [ ] **Section 2** — Functional smoke: all boxes ticked.
- [ ] **Section 3** — Event detection smoke: all 11 types posted or validated.
- [ ] **Section 4** — Anti-spam smoke: quotas confirmed.
- [ ] **Section 5** — Silent-period smoke: gate ON → silent; gate OFF → publishes.
- [ ] **Section 6** — Weekly digest smoke: digest sent, opt-out respected.
- [ ] **Section 7** — DR smoke: live drill completed on second VPS in < 30 min.

Once all boxes above are ticked, the owner may proceed to:

1. **Issue #21** — `secrets-rotation-and-1password`: rotate all plaintext `.env` secrets to 1Password.
2. **Soft-launch**: add the real community group ID to `TELEGRAM_ALLOWED_CHAT_IDS` and set `EVENTS_PUBLISHING_ENABLED_AFTER` to `now + 7 days` (silent-period onboarding window).

See [`docs/runbook/setup-from-scratch.md`](setup-from-scratch.md) section 4 for the soft-launch sequence.

---

## Quick reference — useful commands

```bash
# App health
curl -f https://bot.<your-domain>/healthz

# Live logs
docker logs -f valorant-bot-app

# sqlite3 quick queries
docker exec valorant-bot-app sqlite3 /app/data/data.db "SELECT count(*) FROM users;"
docker exec valorant-bot-app sqlite3 /app/data/data.db "SELECT event_type, status, detected_at FROM detected_events ORDER BY id DESC LIMIT 20;"
docker exec valorant-bot-app sqlite3 /app/data/data.db "SELECT telegram_id, chat_realtime_disabled FROM opt_outs;"

# Restart app only (no image rebuild)
ssh deploy@<VPS_IP> "cd /opt/valorant-bot && docker compose up -d --no-deps app"
```
