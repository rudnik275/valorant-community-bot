# Reference images for the weekly promo image (#227)

The Friday 18:45 Kyiv "prepare" tick generates a promo image for the weekly
digest via OpenAI (`gpt-image-2`). It passes two reference PNGs — the most-
played agent and the most-played map of the week — so the model keeps the
recognizable vibe and palette.

**These PNGs are placed manually by the operator** (binary assets are not
committed by the agent). Until they exist, the digest still posts on time —
text-only — and a warn is logged with the missing agent/map name.

## Layout

```
src/assets/agents/<slug>.png   — agent card from https://playvalorant.com/ru-ru/agents/
src/assets/maps/<slug>.png     — map preview from https://playvalorant.com/ru-ru/maps/
```

`<slug>` is the agent/map display name lowercased with everything that is not
`[a-z0-9]` removed (see `src/server/story/agent-map-fixtures.ts`
`normalizeSlug`). Examples: `KAY/O` → `kayo.png`, `Killjoy` → `killjoy.png`,
`Ascent` → `ascent.png`.

## Checklist (issue #227 §11 — verify current roster on playvalorant.com)

Agents (≈26): `astra, breach, brimstone, chamber, clove, cypher, deadlock,
fade, gekko, harbor, iso, jett, kayo, killjoy, neon, omen, phoenix, raze,
reyna, sage, skye, sova, tejo, viper, vyse, waylay`

Maps (12): `abyss, ascent, bind, breeze, corrode, fracture, haven, icebox,
lotus, pearl, split, sunset`

A missing slug (new agent/map not yet added) is non-fatal — `resolveAgentImage`
/ `resolveMapImage` return `null`, the prepare tick warns with the name and
skips the image; the digest posts text-only.
