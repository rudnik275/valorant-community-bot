# Riot-supplied values over our own heuristics (Henrik v4.10)

**Status:** accepted (2026-10-12)

## Context

Henrik API v4.10 (marked beta in the changelog, already live on
`api.henrikdev.xyz`) exposes verdicts the bot either computed itself or did not
have at all (#384, verified on a real `console_competitive` match 2026-10-11):

- `metadata.mvp` — Riot's match MVP. We derived `is_match_mvp` as "top combat
  score of the 10 players", which crowned every tied player.
- `rounds[].first_blood`, `rounds[].ceremony_player` — who opened the round,
  whom Riot credits for an Ace / Clutch / Closer ceremony.
- `players[].performance.score` — Riot's per-player performance rating.
- MMR v3 `data.latest_update` — the RR update for the player's last match:
  `tier_before_update`, `last_change`. `match_records.rank_before` had been
  null since the v4 pivot.

Owner decision (2026-10-12): where Riot already gives a value, use it instead
of our own computation — fewer points of failure.

## Decision

- `is_match_mvp` comes from `metadata.mvp.puuid` (exactly one player per
  match). The combat-score heuristic stays only as the fallback for matches
  where Henrik sends no `mvp`.
- `rank_before` and the new `rr_change` column come from MMR v3
  `latest_update`, matched by `latest_update.match_id`. The scan already calls
  MMR on every tick, so this costs no request. It covers ONE match: if a tick
  finds several new matches for a player, only the newest is stamped (the rest
  are left for a follow-up via mmr-history, #388); friends' lobby records are
  never stamped from the scan target's MMR.
- `rounds_compact` gains `fb` / `fbt` (first-blood puuid / team) and `cp`
  (ceremony-player puuid); `match_records.performance_score` stores
  `performance.score`. `ratings.grade` is not stored (9/10 players get
  "pass"); `competitive_movement` is ignored (`MOVEMENT_UNKNOWN` even on a real
  demotion).
- Not changed: aces stay counted by kills (ADR 0003) — Riot's `CeremonyAce`
  remains deliberately rejected, and `ceremony_player` is stored data only.
  `fall_damage_kills` is unchanged: v4.10 still does not name a death's source
  (#338).

## Consequences

- Going forward only, no backfill: rows written before the deploy have no
  `fb` / `fbt` / `cp`, `performance_score` or `rr_change`, and their MVP flag
  stays the heuristic one. Features built on these fields count from the
  deploy date; consumers treat absence as "unknown", never as "nobody".
- A combat-score tie no longer produces two match MVPs, so weekly MVP counts
  run slightly lower than under the heuristic.
- The scan now reads five more Henrik fields, all `nullish` in the zod
  schemas: if Henrik drops them, the MVP falls back to the heuristic and the
  rest stay null — ingestion never fails on their account.
