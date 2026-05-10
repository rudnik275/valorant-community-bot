# Valorant Community Bot

Telegram bot for a friend-group Valorant community. Watches for new matches via the HenrikDev API, posts real-time notifications and weekly digests to the group chat.

## Publishing

Events publish in real time per friend, subject to antispam quotas (max 2 chat notifications per day per group, max 1 per player per day, quiet hours ≥12:00 Kyiv time). The `EVENTS_PUBLISHING_ENABLED_AFTER` environment variable should be left empty in production — events post immediately. The silent-period mechanism remains in code as a safety valve; to temporarily silence the bot set this var to a future ISO 8601 timestamp and redeploy.

## Getting started

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) for secret resolution
- Docker + Docker Compose for production deploy

### Local development

```sh
cp .env.example .env
# Fill in required values in .env (or use with-secrets.sh for 1Password-backed secrets)
bun install
bun run dev
```

### Running tests

```sh
bun test
bun run typecheck
```

### Production deploy

Secrets are managed via `.env.1password` (1Password references, safe to commit). To push a new env to the VPS:

```sh
SSH_HOST=<vps-ip> SSH_USER=deploy ./scripts/deploy-env.sh
```

## Environment variables

See `.env.example` for the full list with comments. Key variables:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated list of allowed chat IDs |
| `HENRIK_API_KEY` | HenrikDev API key (optional) |
| `EVENTS_PUBLISHING_ENABLED_AFTER` | Leave empty — events publish immediately |
| `SCANNER_DISABLED` | Set to `false` to enable match scanning |
| `PUBLIC_BASE_URL` | Public hostname for the bot (e.g. `https://bot.example.com`) |
