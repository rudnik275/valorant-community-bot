# Reference images for the weekly promo image (#227)

The Sunday 18:45 Kyiv "prepare" tick generates a promo image for the weekly
digest via OpenAI (`chatgpt-image-latest`). It passes two reference PNGs — the most-
played agent and the most-played map of the week — so the model keeps the
recognizable vibe and palette.

**These PNGs are added by hand** — by the operator, or by an agent when asked
(#403). Until one exists, the digest still posts on time — text-only — and a
warn is logged with the missing agent/map name.

## Layout

```
src/assets/agents/<slug>.png   — valorant-api.com agent `fullPortrait` (2048×1860),
                                 resized to 1280×1163, palette PNG
src/assets/maps/<slug>.png     — map preview from https://playvalorant.com/ru-ru/maps/
```

`<slug>` is the agent/map display name lowercased with everything that is not
`[a-z0-9]` removed (see `src/server/story/agent-map-fixtures.ts`
`normalizeSlug`). Examples: `KAY/O` → `kayo.png`, `Killjoy` → `killjoy.png`,
`Ascent` → `ascent.png`.

## Checklist (issue #227 §11 — verify current roster on playvalorant.com)

Agents (30): `astra, breach, brimstone, chamber, clove, cypher, deadlock,
fade, gekko, harbor, hush, iso, jett, kayo, killjoy, miks, neon, omen, phoenix,
raze, reyna, sage, skye, sova, tejo, veto, viper, vyse, waylay, yoru`

Maps (13): `abyss, ascent, bind, breeze, corrode, fracture, haven, icebox,
lotus, pearl, split, summit, sunset`

A missing slug (new agent/map not yet added) is non-fatal — `resolveAgentImage`
/ `resolveMapImage` return `null`, the prepare tick warns with the name and
skips the image; the digest posts text-only.
