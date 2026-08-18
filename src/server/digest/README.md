# digest/

The weekly digest — built Friday, posted to the group chat.

- `build.ts` — queries the 7-day window and assembles ONE structured model
  (`RichDigestModel`) covering every section.
- `rich-render.ts` — renders that model twice: the Rich Message html the group
  actually sees, and the plain-text fallback used when `sendRichMessage` fails.
  Layout is **flat lines, no tables** (owner, 2026-08-04 — tables read badly on
  a phone).
- `ace-knife.ts` — the «Эйсы недели» / «Ножи недели» leaderboards: who got how
  many over the week. The per-occurrence detail lives in the standalone 23:00
  daily post (`../digest-daily/`, restored 2026-08-18) — both read the same
  `detected_events` rows and coexist.
- `loop.ts` / `two-phase.ts` — scheduling and the Fri 18:45 prepare / 19:00
  publish split for the promo image.

Everything the digest reads comes from `match_records`, which the scanner
populates from **ranked (`console_competitive`) matches only** — so every
record and leaderboard here is ranked-only by construction.
