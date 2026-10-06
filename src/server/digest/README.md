# digest/

The weekly digest — built Sunday 19:00 Kyiv, posted to the group chat.
It moved from Fridays on 2026-10-07; the first Sunday window (to
2026-10-11) reaches back to the last Friday digest — `../lib/kyiv-week.ts`.

- `build.ts` — queries the 7-day window and assembles ONE structured model
  (`RichDigestModel`) covering every section.
- `rich-render.ts` — renders that model twice: the Rich Message html the group
  actually sees, and the plain-text fallback used when `sendRichMessage` fails.
  Layout is **flat lines, no tables** (owner, 2026-08-04 — tables read badly on
  a phone).
- `ace-knife.ts` — the «Эйсы недели» / «Ножи недели» leaderboards: who got how
  many over the week. The standalone 23:00 daily post (`../digest-daily/`,
  restored 2026-08-18) is the same kind of count list for one day — it reuses
  `readOccurrences` so a day's `×N` adds up to the week's — and both read the
  same `detected_events` rows and coexist.
- `loop.ts` / `two-phase.ts` — scheduling and the Sun 18:45 prepare / 19:00
  publish split for the promo image.

Everything the digest reads comes from `match_records`, which the scanner
populates from **ranked (`console_competitive`) matches only** — so every
record and leaderboard here is ranked-only by construction.
