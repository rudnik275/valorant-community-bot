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
