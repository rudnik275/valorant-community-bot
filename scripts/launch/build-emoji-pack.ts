/**
 * build-emoji-pack.ts — (re)build the Valorant custom-emoji pack.
 *
 * Source of truth for the `custom_emoji_id`s hard-coded in
 *   src/server/publisher/rank-emoji.ts   (ranks, keyed by tier number)
 *   src/server/publisher/valorant-emoji.ts (agents / maps / weapons)
 *
 * Why a single group pack: the friend-group supergroup is boosted, so it has a
 * designated custom-emoji set (`getChat.custom_emoji_sticker_set_name`). A bot
 * WITHOUT Telegram Premium can only render custom emoji that belong to THAT one
 * set — verified empirically. So everything the bot wants to render must live in
 * a single pack, and that pack must be set as the group's emoji pack (done by a
 * human admin in group settings; the Bot API cannot set it).
 *
 * Assets come from valorant-api.com (official icons):
 *   agents  — displayIcon (transparent portrait)        → fit: contain
 *   weapons — displayIcon (white silhouette)             → fit: contain
 *   ranks   — competitivetiers[last].tiers[].largeIcon   → fit: contain
 *   maps    — splash (cinematic photo)                   → fit: cover (square tile)
 * All normalised to 100×100 PNG (custom-emoji requirement).
 *
 * Prerequisites (this is a rarely-run maintenance tool, not part of the app):
 *   bun add -d sharp           # image processing, not a runtime dependency
 *   with-secrets bun scripts/launch/build-emoji-pack.ts
 *
 * After running, copy the printed ids into rank-emoji.ts / valorant-emoji.ts
 * (or read OUT/id-map.json). Re-running deletes + recreates the set, so ids
 * change — refresh BOTH modules together. Refresh when Riot ships a new
 * agent/map/weapon (the group pack will be missing it until then).
 */
import sharp from 'sharp';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) { console.error('TELEGRAM_BOT_TOKEN not set — run via with-secrets'); process.exit(1); }
const OWNER = 419486914; // bot owner's Telegram user id (set owner; see test-commands.ts)
const NAME = 'valorant_npc_by_valorant_comunity_bot'; // must end with _by_<bot username>
const TITLE = 'Valorant NPC';
const OUT = `${import.meta.dir}/.emoji-pack-build`;
const ICONS = `${OUT}/icons`;
const scrub = (s: string) => s.split(token!).join('<token>');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const san = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const ALIAS: Record<string, string> = { agent: '🦸', map: '🗺️', weapon: '🔫', rank: '🏅' };

async function api(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}
async function getJson(u: string): Promise<any> { return (await fetch(u)).json(); }

// ── 1. fetch + normalise assets ──────────────────────────────────────────────
type Entry = { category: string; key: string; file: string };
async function tile(url: string, out: string, fit: 'contain' | 'cover'): Promise<boolean> {
  const r = await fetch(url);
  if (!r.ok) return false;
  const opts = fit === 'cover'
    ? { fit: 'cover' as const, position: 'centre' as const }
    : { fit: 'contain' as const, background: { r: 0, g: 0, b: 0, alpha: 0 } };
  await sharp(Buffer.from(await r.arrayBuffer())).resize(100, 100, opts).png({ compressionLevel: 9 }).toFile(out);
  return true;
}

async function fetchAssets(): Promise<Entry[]> {
  const manifest: Entry[] = [];
  for (const cat of ['agent', 'map', 'weapon', 'rank']) mkdirSync(`${ICONS}/${cat}`, { recursive: true });

  const agents = (await getJson('https://valorant-api.com/v1/agents?isPlayableCharacter=true')).data;
  for (const a of agents) {
    if (!a.displayIcon) continue;
    const file = `agent/${san(a.displayName)}.png`;
    if (await tile(a.displayIcon, `${ICONS}/${file}`, 'contain')) manifest.push({ category: 'agent', key: a.displayName, file });
  }

  const maps = (await getJson('https://valorant-api.com/v1/maps')).data;
  for (const m of maps) {
    const src = m.splash ?? m.listViewIcon;
    if (!m.displayName || !src || !m.displayIcon) continue; // displayIcon gate keeps real maps only
    const file = `map/${san(m.displayName)}.png`;
    if (await tile(src, `${ICONS}/${file}`, 'cover')) manifest.push({ category: 'map', key: m.displayName, file });
  }

  const weapons = (await getJson('https://valorant-api.com/v1/weapons')).data;
  for (const w of weapons) {
    if (!w.displayIcon || !w.displayName) continue;
    const file = `weapon/${san(w.displayName)}.png`;
    if (await tile(w.displayIcon, `${ICONS}/${file}`, 'contain')) manifest.push({ category: 'weapon', key: w.displayName, file });
  }

  const tiers = (await getJson('https://valorant-api.com/v1/competitivetiers')).data;
  for (const t of tiers[tiers.length - 1].tiers) {
    if (!t.largeIcon) continue; // skips Unused 1/2
    const file = `rank/${t.tier}_${san(t.tierName)}.png`;
    if (await tile(t.largeIcon, `${ICONS}/${file}`, 'contain')) manifest.push({ category: 'rank', key: String(t.tier), file });
  }

  writeFileSync(`${ICONS}/asset-manifest.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}

// ── 2. (re)create the pack ───────────────────────────────────────────────────
async function uploadSticker(e: Entry): Promise<string> {
  const fd = new FormData();
  fd.append('user_id', String(OWNER));
  fd.append('sticker_format', 'static');
  fd.append('sticker', new Blob([readFileSync(`${ICONS}/${e.file}`)], { type: 'image/png' }), e.file.split('/').pop());
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/uploadStickerFile`, { method: 'POST', body: fd });
    const j: any = await res.json();
    if (j.ok) return j.result.file_id;
    if (j.error_code === 429 && attempt < 5) { await sleep((j.parameters?.retry_after ?? 2) * 1000 + 500); continue; }
    throw new Error(`upload ${e.file}: ${scrub(JSON.stringify(j))}`);
  }
}
const inputSticker = (e: Entry, fileId: string) => ({ sticker: fileId, format: 'static', emoji_list: [ALIAS[e.category] ?? '⭐'] });

async function buildPack(manifest: Entry[]): Promise<void> {
  // free the name if it already exists (ids change on every rebuild)
  await api('deleteStickerSet', { name: NAME });
  for (let i = 0; i < 10; i++) { if (!(await api('getStickerSet', { name: NAME })).ok) break; await sleep(1000); }

  const first = await uploadSticker(manifest[0]!);
  const created = await api('createNewStickerSet', {
    user_id: OWNER, name: NAME, title: TITLE, sticker_type: 'custom_emoji',
    stickers: [inputSticker(manifest[0]!, first)],
  });
  if (!created.ok) throw new Error('createNewStickerSet: ' + scrub(JSON.stringify(created)));
  for (let i = 0; i < 15; i++) { if ((await api('getStickerSet', { name: NAME })).ok) break; await sleep(1000); }

  for (let i = 1; i < manifest.length; i++) {
    const fid = await uploadSticker(manifest[i]!);
    for (let attempt = 0; ; attempt++) {
      const j = await api('addStickerToSet', { user_id: OWNER, name: NAME, sticker: inputSticker(manifest[i]!, fid) });
      if (j.ok) break;
      const retryable = j.error_code === 429 || String(j.description ?? '').includes('STICKERSET_INVALID');
      if (retryable && attempt < 8) { await sleep((j.parameters?.retry_after ?? 2) * 1000 + 800); continue; }
      throw new Error(`addSticker ${manifest[i]!.file}: ${scrub(JSON.stringify(j))}`);
    }
    await sleep(400);
  }
}

// ── 3. collect ids (set order == insertion order == manifest order) ───────────
async function collectIds(manifest: Entry[]): Promise<void> {
  const set = await api('getStickerSet', { name: NAME });
  if (!set.ok) throw new Error('getStickerSet: ' + scrub(JSON.stringify(set)));
  const stickers = set.result.stickers as any[];
  const idMap = manifest.map((e, i) => ({ category: e.category, key: e.key, custom_emoji_id: stickers[i]?.custom_emoji_id }));
  writeFileSync(`${OUT}/id-map.json`, JSON.stringify(idMap, null, 2));
  const by = (c: string) => idMap.filter((x) => x.category === c).length;
  console.log(`pack=${NAME} total=${idMap.length} (agents=${by('agent')} maps=${by('map')} weapons=${by('weapon')} ranks=${by('rank')})`);
  console.log(`id-map → ${OUT}/id-map.json — copy ids into rank-emoji.ts + valorant-emoji.ts`);
}

mkdirSync(OUT, { recursive: true });
const manifest = await fetchAssets();
console.log(`fetched ${manifest.length} icons`);
await buildPack(manifest);
await collectIds(manifest);
