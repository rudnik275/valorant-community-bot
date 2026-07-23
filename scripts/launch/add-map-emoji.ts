/**
 * add-map-emoji.ts — idempotently ADD a single new map's icon to the existing
 * Valorant custom-emoji pack, WITHOUT rebuilding the whole set.
 *
 * Why a separate tool from build-emoji-pack.ts: that script DELETES and
 * recreates the entire pack, which changes every `custom_emoji_id` and forces
 * a refresh of both rank-emoji.ts and valorant-emoji.ts. When Riot ships a
 * single new map (e.g. Summit, #311) we only want to APPEND it — every existing
 * id stays valid, and we just paste the ONE new id into valorant-emoji.ts.
 *
 * Same conventions as build-emoji-pack.ts:
 *   - asset source: valorant-api.com map `splash` (cinematic photo)
 *   - normalise to 100×100 PNG, fit: cover (square tile) — custom-emoji format
 *   - Bot API via TELEGRAM_BOT_TOKEN, owner user id as the sticker owner
 *
 * IDEMPOTENT: the Summit sticker is tagged with a distinctive alias emoji
 * (⛰️) instead of the generic map alias (🗺️) the bulk builder uses, so a
 * re-run can detect it via getStickerSet and skip the add. Re-running always
 * prints the current custom_emoji_id — safe to run twice.
 *
 * Usage (owner only — needs the bot token, not available to AI sessions):
 *   op run --env-file=.env.1password -- bun scripts/launch/add-map-emoji.ts Summit
 *
 * After running, paste the printed id into src/server/publisher/valorant-emoji.ts
 * MAP_EMOJI (key = name lowercased, non-alphanumerics stripped — "Summit" → summit).
 */
import sharp from 'sharp';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN not set — run via: op run --env-file=.env.1password -- bun scripts/launch/add-map-emoji.ts Summit');
  process.exit(1);
}

const mapName = process.argv[2];
if (!mapName) {
  console.error('Usage: bun scripts/launch/add-map-emoji.ts <MapName>   (e.g. Summit)');
  process.exit(1);
}

const OWNER = 419486914; // bot owner's Telegram user id (matches build-emoji-pack.ts)
const NAME = 'valorant_npc_by_valorant_comunity_bot'; // the group's designated emoji pack
// Distinctive alias emoji for a freshly-appended map, so getStickerSet can find
// it on re-run. The bulk builder tags every map with 🗺️; a per-map add uses ⛰️.
const MAP_ADD_ALIAS = '⛰️';

const t = token; // non-null within this module
const scrub = (s: string) => s.split(t).join('<token>');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Same slug rule as valorant-emoji.ts `norm` — lowercase, strip non-alphanumerics. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

async function api(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function getJson(u: string): Promise<any> {
  return (await fetch(u)).json();
}

/** valorant-api map splash → 100×100 PNG buffer, fit: cover (matches build-emoji-pack.ts maps). */
async function tileSplash(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch splash ${url}: HTTP ${r.status}`);
  return sharp(Buffer.from(await r.arrayBuffer()))
    .resize(100, 100, { fit: 'cover', position: 'centre' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function uploadSticker(png: Buffer, filename: string): Promise<string> {
  const fd = new FormData();
  fd.append('user_id', String(OWNER));
  fd.append('sticker_format', 'static');
  fd.append('sticker', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${t}/uploadStickerFile`, { method: 'POST', body: fd });
    const j: any = await res.json();
    if (j.ok) return j.result.file_id;
    if (j.error_code === 429 && attempt < 5) {
      await sleep((j.parameters?.retry_after ?? 2) * 1000 + 500);
      continue;
    }
    throw new Error(`uploadStickerFile: ${scrub(JSON.stringify(j))}`);
  }
}

async function main(): Promise<void> {
  const slug = norm(mapName!);
  if (!slug) throw new Error(`map name "${mapName}" normalises to empty`);

  // ── 0. resolve the map on valorant-api (splash + displayName) ──────────────
  const maps = (await getJson('https://valorant-api.com/v1/maps')).data as any[];
  const map = maps.find((m) => m.displayName && norm(m.displayName) === slug);
  if (!map) throw new Error(`map "${mapName}" not found on valorant-api.com (checked ${maps.length} maps)`);
  const src = map.splash ?? map.listViewIcon;
  if (!src) throw new Error(`map "${map.displayName}" has no splash/listViewIcon on valorant-api.com`);
  console.log(`resolved ${map.displayName} — splash: ${src}`);

  // ── 1. idempotency: is a per-map-added sticker already in the set? ─────────
  // We can't tell WHICH map a 🗺️-tagged sticker is, but our per-map adds are
  // tagged ⛰️, and there is at most one at a time (one new map per PR). If one
  // exists, assume it's this map and just print its id — never add a duplicate.
  const existing = await api('getStickerSet', { name: NAME });
  if (!existing.ok) throw new Error(`getStickerSet (pre-check): ${scrub(JSON.stringify(existing))}`);
  const already = (existing.result.stickers as any[]).find((s) => s.emoji === MAP_ADD_ALIAS);
  if (already) {
    console.log(`\n✅ ${map.displayName} already in pack "${NAME}" (alias ${MAP_ADD_ALIAS}) — skipping add.`);
    console.log(`\n${slug}: '${already.custom_emoji_id}', // ${map.displayName}`);
    console.log(`\n→ paste the line above into src/server/publisher/valorant-emoji.ts MAP_EMOJI (if not already there).`);
    return;
  }

  // ── 2. build tile + append to the set ─────────────────────────────────────
  console.log('normalising splash → 100×100 PNG …');
  const png = await tileSplash(src);
  const fileId = await uploadSticker(png, `${slug}.png`);

  const added = await api('addStickerToSet', {
    user_id: OWNER,
    name: NAME,
    sticker: { sticker: fileId, format: 'static', emoji_list: [MAP_ADD_ALIAS] },
  });
  if (!added.ok) throw new Error(`addStickerToSet: ${scrub(JSON.stringify(added))}`);
  console.log(`added ${map.displayName} to ${NAME}`);

  // ── 3. fetch the set back and print the NEW sticker's custom_emoji_id ──────
  // The appended sticker is the last one; also match by our alias to be safe.
  await sleep(1000);
  const set = await api('getStickerSet', { name: NAME });
  if (!set.ok) throw new Error(`getStickerSet (post-add): ${scrub(JSON.stringify(set))}`);
  const stickers = set.result.stickers as any[];
  const mine = stickers.find((s) => s.emoji === MAP_ADD_ALIAS) ?? stickers[stickers.length - 1];
  const id = mine?.custom_emoji_id;
  if (!id) throw new Error(`could not read custom_emoji_id back from getStickerSet: ${scrub(JSON.stringify(set))}`);

  console.log(`\n✅ ${map.displayName} custom_emoji_id: ${id}`);
  console.log(`\nPaste into src/server/publisher/valorant-emoji.ts MAP_EMOJI:`);
  console.log(`\n  ${slug}: '${id}', // ${map.displayName}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
