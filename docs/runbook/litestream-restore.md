# Litestream Restore Runbook

Operator guide for recovering the valorant-community-bot SQLite database from Hetzner Object Storage using Litestream.

---

## Pre-conditions

- Hetzner Object Storage bucket is accessible (bucket name and endpoint are set in `.env`).
- `/opt/valorant-bot/.env` contains valid values for all four `LITESTREAM_S3_*` variables:
  - `LITESTREAM_S3_BUCKET`
  - `LITESTREAM_S3_ENDPOINT`
  - `LITESTREAM_S3_ACCESS_KEY_ID`
  - `LITESTREAM_S3_SECRET_ACCESS_KEY`
- Docker is installed on the VPS and the litestream image can be pulled.
- You have SSH access to the VPS.

---

## Step-by-step

### 1. SSH into the VPS

```
ssh root@<VPS_IP>
```

### 2. Stop the app container

The app must be stopped before restore to avoid file conflicts.

```
cd /opt/valorant-bot && docker compose stop app
```

Verify it is stopped:

```
docker compose ps app
```

Expected: `State` is `exited` or the container is absent.

### 3. Run the restore script

The script is idempotent — it is safe to run twice. If a database file already exists it will be backed up with a timestamp suffix before restore.

```
bash /opt/valorant-bot/scripts/litestream-restore.sh
```

The script will:
1. Check that the app container is not running (exits with error if it is).
2. Back up any existing `data.db` to `data.db.bak.<unix-timestamp>`.
3. Run `litestream restore -if-replica-exists` — downloads the latest snapshot + WAL segments from S3.
4. Run `PRAGMA integrity_check` — exits with error if the result is not `ok`.
5. Print a confirmation message.

If the bucket has no replica yet (first-ever deploy, no backup uploaded), the script exits cleanly with an informational message — nothing is corrupted.

### 4. Verify data

```
sqlite3 /opt/valorant-bot/data/data.db 'PRAGMA integrity_check'
```

Expected output: `ok`

Check row counts in key tables:

```
sqlite3 /opt/valorant-bot/data/data.db 'SELECT count(*) FROM users'
sqlite3 /opt/valorant-bot/data/data.db 'SELECT count(*) FROM match_records'
```

### 5. Start the app

```
cd /opt/valorant-bot && docker compose up -d
```

Check logs to confirm the bot is healthy:

```
docker logs -f valorant-bot-app
```

---

## Recovery time estimate

- SQLite database ~50 MB: approximately 1 minute over a typical VPS network link.
- Larger databases or slow S3 endpoints may take longer. The restore uses streaming so memory usage is bounded.

---

## Troubleshooting

| Symptom | Action |
|---------|--------|
| `ERROR: app container is still running` | Run `docker compose stop app` then re-run the script. |
| `integrity_check` fails | The downloaded file is corrupt. Check litestream logs, try restoring an older snapshot by running litestream restore with explicit `-timestamp` flag. |
| `no replica exists` info message | No backup has been uploaded yet — start the app normally (fresh deploy). |
| S3 auth error during restore | Verify `LITESTREAM_S3_ACCESS_KEY_ID` and `LITESTREAM_S3_SECRET_ACCESS_KEY` in `.env` match the Hetzner Console credentials. |
| Wrong endpoint | `LITESTREAM_S3_ENDPOINT` must be the full HTTPS URL, e.g. `https://valorant-bot-litestream.fsn1.your-objectstorage.com`. |

---

## Related

- Litestream configuration: `infra/valorant-bot/litestream.yml`
- Docker Compose with litestream sidecar: `infra/valorant-bot/docker-compose.prod.yml`
- Hetzner Object Storage setup: `docs/runbook/setup-from-scratch.md` — Hetzner Object Storage section
- Restore script source: `scripts/litestream-restore.sh`
