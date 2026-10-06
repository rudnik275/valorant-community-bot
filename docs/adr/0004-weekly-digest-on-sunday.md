# Weekly digest moves from Friday to Sunday; the first Sunday window spans the switch

**Status:** accepted (2026-10-07)

## Context

The weekly digest posted Fri 19:00 Kyiv (`0 19 * * 5`). The owner moved it to
Sunday (2026-10-07); the post time stays 19:00.

"A week" in this bot is not the ISO calendar week — it is the window between two
digests (`lib/kyiv-week.ts`, see the 2026-08-09 «Король MVP» incident in its
header). Both the live tick and `records-rebuild.ts` derive `weekly_records`
from it, so whatever the schedule is, they must agree on every window — past
ones included.

A plain cron swap would have opened the first Sunday window at Sun 2026-10-04
19:00 (7 days back), dropping Fri 2026-10-02 19:00 → Sun 2026-10-04 19:00 — a
whole weekend of aces, knives, records and MVPs — from every digest. And
re-bucketing all history into Sun→Sun windows would make a rebuild rewrite past
weeks with counts no Friday digest ever announced.

## Decision

- The digest posts Sun 19:00 Kyiv (`WEEKLY_DIGEST_CRON = '0 19 * * 0'`; the
  disabled prepare tick at Sun 18:45). Both crons live in `lib/kyiv-week.ts`
  next to the window math that must match them.
- The schedule is history-aware: play before `LAST_FRIDAY_DIGEST_MS`
  (Fri 2026-10-02 19:00) keeps its Fri→Fri windows; everything from then until
  `FIRST_SUNDAY_DIGEST_MS` (Sun 2026-10-11 19:00) is ONE nine-day window keyed
  `2026-W41`; Sun→Sun from then on.
- `digestWeekStartFor` opens the first Sunday window at the last Friday digest
  by a range check, so the 18:45 prepare build and preview runs that week reach
  back just as far.
- The group was told in advance: no digest on Fri 2026-10-09, the Sunday one
  covers everything since the last digest, then every Sunday.

## Consequences

- The first Sunday digest covers nine days, so its «Король MVP за неделю» count
  can run higher than a normal week's and may set the all-time weekly bar.
  Accepted — the owner asked for the full period.
- The switch constants are dated: they assume this change was live before the
  old Fri 2026-10-09 18:45 prepare / 19:00 post. Had a Friday W41 digest
  posted, the Sunday W41 run would dedup away on `digest_runs.week_iso`.
- The Healthchecks.io weekly-digest check (simple 1-week period + 25h grace)
  sees a nine-day gap once and alerts around Sat 2026-10-10 20:00 Kyiv; it
  recovers on the Sunday ping.
