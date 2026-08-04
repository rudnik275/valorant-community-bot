# Ace = ≥5 enemy kills in a round (drop CeremonyAce, drop unique-victim requirement)

**Status:** accepted (2026-05-14)

## Context

The ace detector previously trusted Henrik's `rounds[].ceremony === "CeremonyAce"` as ground truth (introduced in commit `3e45e7f`, "trust Henrik's rounds[].ceremony for ace"). That signal was attractive because Riot only fires the in-game ace banner when one player kills each unique enemy (no revived re-kills, no environmental/teamkill credit) — so the detector inherited Riot's exact semantics for free.

The friend group has hit two cases where this is wrong-for-us:

1. **Player aced, then spike detonated and killed them before round end.** Riot does not fire the ceremony when the ace-getter dies before round end, even though the kill log clearly shows all five enemies were shot by the player. The bot stays silent — demotivating, because everyone watched the play happen.
2. **Player got 5+ kills in a round but one enemy was revived (Sage) and re-killed.** Strict Riot rule: only 4 unique enemies, not an ace. But in our friend group this is still a celebration-worthy moment — five trigger pulls, five down bodies on screen.

We are not building a strict Valorant stats engine. We are building a chat that hypes our friends.

## Decision

Detect ace as **≥5 kills by the player against enemies (non-self, non-teammate) in a single round**, period.

- Drop the `CeremonyAce` filter — `rounds_compact[].c` is no longer consulted for ace detection.
- Drop the unique-`victim_puuid` dedup at the **threshold** check. A revived enemy re-killed counts toward the 5.
- Friendly-fire kills (same team) still excluded.
- Self-kills (spike suicide) still excluded.
- `victims` / `victim_names_for_template` in the event payload remain deduped (for opponent-peak augmentation and clean display of names).

Daily Ace digest format also changes to surface per-round outcome (💀 round lost / 🏆 round won) — the new heuristic admits aces that didn't win the round (e.g. spike-explosion case), so the digest acknowledges this rather than hiding it.

## Considered options

**A. ≥5 unique enemy victims (Riot-aligned, looser than ceremony).** Catches the spike-explosion case but not the Sage-revive case. Rejected — the friend group treats both as ace-worthy.

**B. ≥5 kills, no uniqueness requirement.** Chosen. Trades formal correctness for chat hype value.

## Consequences

- **Diverges from in-game "ace"** semantics. A future reader looking at a published "ace" event may find a round where one enemy was alive at end-of-round (because they got revived and re-killed). This is intentional, not a bug.
- **Reverses `3e45e7f`.** Reading old code comments / commits about "ceremony as ground truth" requires this ADR for context.
- **`rounds_compact[].c` becomes unused for ace.** Other detectors may still use it; if nothing else does, the scanner can stop emitting it later (out of scope here).
- **Going-forward only.** No backfill of `match_records` already scanned with the old logic — we accept that historic missed aces stay missed.

## 2026-05-15 — single-list message format

The daily digest layout is reorganised into a single chronological list (`src/server/digest-daily/build.ts`). Aces and knife kills are no longer grouped into two separate sections; each row carries a leading type emoji (`🎯` for ace, `🔪` for knife) and Europe/Kyiv `HH:MM`. Multi-round events fan out into one row per round (sorted ascending), so a Sage-revive 6-kill round and a same-match second ace each get their own line. The header (`🍿 Эйсы и ножи за предыдущие 24 часа`) is plain text at the top, and the legend now lives in a Telegram `<blockquote>` with one row per emoji (4 rows total). Selection rules, status filtering, dedupe by `daily_digest_runs.run_date` and the 23:00 Europe/Kyiv schedule are unchanged.

## 2026-08-04 — daily digest removed; ace/knife become weekly counts

The core decision above (**ace = ≥5 enemy kills in a round**) is unchanged — it
is still exactly what the detector emits and what gets counted.

What is superseded is the *delivery* described in the 2026-05-15 section. The
owner moved aces and knife kills out of the standalone 23:00 post and into the
weekly digest as plain per-player leaderboards — «кто сколько эйсов сделал, кто
сколько ножей сделал». Consequently:

- `EVENT_CATEGORY` has no `'daily'` category any more; `ace` and `knife_kill`
  are `'weekly'` and are inserted `status='digest-only'`.
- The whole `src/server/digest-daily/` module, its 23:00 cron and its
  `daily_digest_runs` bookkeeping are gone. The table is kept for history.
- The single chronological list — per-round rows with `HH:MM`, the 🏆/💀
  round-outcome marker, the round number and the per-round match link — no
  longer exists anywhere. Only counts survive.
- The «заколол баранчика» / «распотрошил гуся» (AFK victim) split is **retired
  entirely** — a knife kill is a knife kill. The knife detector no longer emits
  `victims_afk`, and no message anywhere distinguishes the two. The raw Riot
  flags stay on `match_records.per_round_afk_compact`, so it is re-derivable if
  the joke is ever wanted back.
- The `ace` and `knife_kill` chat templates in `publisher/templates.ts` are
  deleted — both types are weekly now, so neither the publisher loop nor the
  `/test_runtime_events` replay could ever reach them.
- Aces are counted per **aced round**; knife kills per **kill** (two knife kills
  in one round count as 2 — the old daily post deduped them to one row).

See `src/server/digest/ace-knife.ts`.

## 2026-08-04 (позже в тот же день) — 🐴 Троянский конь / ⚓ Якорь наконец видимы

Не относится к определению эйса, но обнаружено при чистке `templates.ts`.

`record_died_first_rounds` (#281) и `record_survived_last_rounds` детектировались
и обновляли `all_time_records`, но **никогда не показывались**: обоих не было ни
в `BRIGHT_EVENT_WEIGHTS`, ни в `RICH_RECORD_META` в `digest/build.ts`. На проде
накопилось 30 таких событий (все `silent`) при рекордах 14 и 12. При этом
near-miss-строка «чуть не стал троянским конём» сработать могла — то есть чат мог
сообщить о почти-рекорде, которого никто никогда не видел.

Починено: оба добавлены как обычные bright-рекорды. Заодно исправлено
расхождение в неймингах — событие `record_died_first_rounds` ведёт запись с
`record_type = 'died_first_rounds_match'` (лишний суффикс `_match`), поэтому
`alreadyBeaten` считался неверно и near-miss не подавлялся. Теперь маппинг явный
(`RECORD_TYPE_OVERRIDES`).
