# digest/

The weekly digest — built Sunday 19:00 Kyiv, posted to the group chat.
It moved from Fridays on 2026-10-07; the first Sunday window (to
2026-10-11) reaches back to the last Friday digest — `../lib/kyiv-week.ts`.

- `build.ts` — queries the 7-day window and assembles ONE structured model
  (`RichDigestModel`) covering every section. Weekly aggregates computed right
  here, with no detected event behind them: «🏆 Больше всех матчей» (≥5
  matches) and «🩸 Открывашка недели» (most first bloods from
  `rounds_compact[].fb`, ≥3).
- `rich-render.ts` — renders that model twice: the Rich Message html the group
  actually sees, and the plain-text fallback used when `sendRichMessage` fails.
  Layout is **flat lines, no tables** (owner, 2026-08-04 — tables read badly on
  a phone).
- `ace-knife.ts` — the «Эйсы недели» / «Ножи недели» / «Клатчи недели»
  leaderboards: who got how many over the week (clutches since #385 — Riot's
  `CeremonyClutch` credited to the player, ADR 0003). The standalone 23:00
  daily post (`../digest-daily/`, restored 2026-08-18; «🍿 Эйсы, ножи и
  клатчи за предыдущие 24 часа») is the same kind of count list for one day —
  it reuses `readOccurrences` so a day's `×N` adds up to the week's — and both
  read the same `detected_events` rows and coexist.
- «🏦 RR недели» (in `build.ts`, after the top-agents query) — each member's
  net RR for the week, `SUM(match_records.rr_change)`: the top gainer 📈 and
  the top loser 📉, with the number of matches whose RR verdict is known.
  Omitted when nobody has a non-zero net. `rr_change` is filled by the scanner
  for each player's newest match per tick; older gaps were seeded once from
  Henrik mmr-history (`../scanner/seed-rr-change.ts`,
  `gh workflow run seed-rr-change.yml -f apply=1`).
- `loop.ts` / `two-phase.ts` — scheduling and the Sun 18:45 prepare / 19:00
  publish split for the promo image.

Everything the digest reads comes from `match_records`, which the scanner
populates from **ranked (`console_competitive`) matches only** — so every
record and leaderboard here is ranked-only by construction.
