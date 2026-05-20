# CLAUDE.md

Guidance for AI assistants (and humans) working in this repo.

## What this project is

Private Telegram bot + Mini App for a ~30-person Valorant friend group. Henrik API → SQLite → grammY bot + Hono server + Vue Mini App. Active source-of-truth for direction is **ADR 0002** (`docs/adr/0002-pivot-back-to-henrik-for-friend-group.md`) and **issue #51**. Read those before structural work.

The original public-product PRD (#1) and architecture v1 (#2) are closed/historical — superseded by ADR 0002.

## Glossary

Domain terms in `CONTEXT.md`. Read it before naming things.

## Methodology

- **GitHub issues are the source-of-truth** for plans and tasks. Don't write planning docs in the repo — open an issue.
- **ADRs** in `docs/adr/` for non-trivial decisions. Format follows `~/dev/slots/docs/adr/`.
- **AFK dispatch** for vertical slices: each agent works in an isolated worktree, opens a PR, auto-merges. Use the `afk-dispatch` skill.
- **Direct push to master is fine** for tiny fixes (typos, doc tweaks). For anything touching code, open a PR so CI runs — there's no branch protection (free-tier private repo) but CI must still go green.

## Secrets

Read `~/.claude/CLAUDE.md` first — it has the global secrets contract. Project specifics:

- All secrets live in 1Password vault `PetProject` (+ `SlotRanker` for shared infra).
- `.env.1password` is committed and contains `op://` references — safe.
- Local: run anything that needs secrets via `./scripts/with-secrets.sh <cmd>`.
- Deploy env to VPS: `SSH_HOST=46.62.229.131 ./scripts/deploy-env.sh` (user only — AI sessions cannot run this; secrets would enter the transcript).
- **Never** read `.env`, run `op item get` / `op read` for secret fields, or echo any secret. Use `op run --env-file=...` or the wrapper script.
- `OPENAI_API_KEY` (`op://PetProject/openai-api-key/credential`) — weekly digest promo image (#227). Empty/missing ⇒ digest still posts on time, text-only. Two-phase weekly: Fri 18:45 Kyiv prepare tick builds the digest + stashes the image; Fri 19:00 publish tick posts the saved text then best-effort photo-reply. Daily digest is unaffected. The image is purely best-effort — it never blocks or delays the digest text.

## Tooling

```sh
bun install            # install
bun run dev            # server (with --watch)
bun run dev:web        # Vite for Mini App
bun test               # vitest
bun run typecheck      # both server + web tsconfigs
bun run db:generate    # drizzle-kit migration from schema diff
bun run db:migrate     # apply migrations to local DB
```

## Testing patterns

- **Vitest with real SQLite** for server tests — do not mock the DB. The methodology memory and past incidents have made this clear: mocked DB tests pass while migrations break in prod.
- **Henrik calls** are fixture-based — fixtures live next to tests. Don't hit the real API in unit tests.
- **Vue components**: `@vue/test-utils` + `jsdom`. Test rendered output and user-visible behaviour, not internal state.
- Match the existing test style for the file you're editing.

## Permissive content stance

This is a private friend-group bot. Comparative stats, K/D, winrates, opponents' peak ranks, etc. are explicitly OK. Don't add ethics filters or opt-outs unless asked. See `valorant_friend_group_permissive.md` in the user's memory for context.

## Deploy & CI

- Push to `master` → GitHub Actions builds amd64 image → ghcr.io → SSH deploy → 60s health-gate → rollback on failure.
- **No branch protection** (free-tier private repo). Auto-merge fires immediately. Verify CI green via `gh pr checks <PR#>` before claiming "done"; if CI failed, roll forward with a fix-up PR — don't leave master red.
- VPS / tunnel / Cloudflare config — see user memory `project_deployment_state.md`.

## Inspecting prod data

The prod image (`ghcr.io/rudnik275/valorant-community-bot`) is minimal and **does NOT include `sqlite3` CLI** — `docker exec valorant-bot-app sqlite3 ...` will fail with "executable file not found". Don't `apk add sqlite` either; keep the image clean.

Instead use the `bun` that's already in the image + the built-in `bun:sqlite` driver. Write a tiny read-only script and pipe it into the container over SSH:

```sh
# /tmp/diag.ts (local):
#   import { Database } from "bun:sqlite";
#   const db = new Database("/app/data/data.db", { readonly: true });
#   console.log(JSON.stringify(db.query("SELECT ...").all(), null, 2));

cat /tmp/diag.ts | ssh root@46.62.229.131 'docker exec -i valorant-bot-app sh -c "cat > /tmp/diag.ts && bun /tmp/diag.ts; rm -f /tmp/diag.ts"'
```

Always open with `{ readonly: true }` so you can't accidentally mutate prod state. Cron tick reality on this bot: missed daily/weekly ticks are **not replayed** by Croner on the next process start — a deploy whose container swap lands on the cron minute drops that tick (see issue history).

## Memory layout

User-level memory lives in `~/.claude/projects/-Users-rudnikdmitriy-dev-valorant-comunity-bot/memory/`. The index file `MEMORY.md` is loaded automatically. Always check it for current strategic direction, behavioural feedback, and infra facts before acting on assumptions.

## Don't

- Don't store project plans in the user memory directory — they belong in GitHub issues.
- Don't generate / refresh the legacy PRDs (#1, #2). They're historical.
- Don't add backward-compat shims for removed features (Variant A gate, RSO scaffold, opt-out toggle, `/about` landing). They're gone.
