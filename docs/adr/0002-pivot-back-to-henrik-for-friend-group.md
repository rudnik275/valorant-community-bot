# Pivot back to Henrik API for friend-group bot

> Supersedes ADR 0001 (issue #49 — never written; closed as superseded).

**Status:** accepted (2026-05-09 evening)

## Context

The project briefly pivoted to a Riot Production + RSO architecture (issues #40–#44, #49) on the assumption that Henrik API returns `code:24` for console accounts, making it useless for our community. A live retest on the evening of 2026-05-09 against `рудi#1111` (a console account) showed full match data returned by Henrik — the console-blocking assumption was wrong.

At the same time, the Riot Production app review process (App ID 834784, submitted 2026-05-09) explicitly disqualifies "small group of friends" use cases. To survive review, the product was repositioned as a public tool — friction that doesn't benefit the actual users. With Henrik working, that repositioning is unnecessary.

The friend-group: ~30 console-Valorant players in one Telegram supergroup. Hosted in `@valorant_npc` (33 members as of 2026-05-10, not planning to grow). The group's `@username` is public for discoverability among the Ukrainian console-Valorant niche, but membership stays at friend-group scale. Public positioning at the **bot/product** level (Riot Production, RSO, /about landing) adds onboarding complexity and Riot compliance overhead without improving the product for anyone in the group.

Full API verification record, fixtures, and console-queue quirks are documented in issue #51.

## Decision

Use **Henrik API** for all Valorant data access. No RSO, no Riot Production credentials, no token storage.

Architecture:
- `/link Name#TAG` command — explicit opt-in per player
- Scanner polls Henrik every 30 min for linked accounts
- Publisher posts match events to the single Telegram group under antispam quotas (2 notifications/day, 1/player, ≥12:00 Kyiv quiet hours)
- Opponents' peak rank shown on ace/clutch events as story context (aggregate, never comparative)
- Console queue identified by `queue.id = "console_competitive"` (no mode filter available)

## Consequences

- Riot Production app 834784 effectively abandoned — closed as `wontfix` after pivot. RSO flow scrapped entirely.
- Onboarding lives in the Mini App (`/onboard` form, Slice C #54). No `/link` chat command was built — the Mini App is the only entry point.
- Privacy gate is opt-in via the Mini App onboarding form — no data collected from non-linked members.
- Henrik's rate limits (30/min on free tier) are compatible with a 30-member group at 30-min poll intervals. Sized for current membership (33) with headroom; revisit only if group grows beyond ~100.
- Production hosting: `@valorant_npc` (chat_id `-1002716344015`, supergroup, public username, 33 members 2026-05-10).
- Wave 2 (2026-05-10) extracted a design system at `docs/design-book.md` and restyled the Mini App (PRs #72–#75) under the new tokens.
- `src/web/public/riot.txt` and the public `/about` landing were removed in PR #64 — no longer needed.
- Permissive content stance adopted 2026-05-10: comparative stats, K/D, opponents' peak ranks all surfaced; opt-out toggle removed (Slice C #54).
- Reference issue #51 for full research record (verified API responses, fixtures, slicing plan issues #52–#57).
