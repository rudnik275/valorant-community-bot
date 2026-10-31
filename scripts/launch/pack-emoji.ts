/**
 * pack-emoji.ts — keep the group's custom-emoji pack in step with the code,
 * WITHOUT rebuilding the whole set.
 *
 *   check              — audit: every id in rank-emoji.ts / valorant-emoji.ts
 *                        exists in the pack, every agent/map on valorant-api.com
 *                        has an id in code, and the pack is still the group's
 *                        designated emoji pack (getChat). Exit 1 on any gap.
 *   add agent <Name>   — append ONE new agent's icon (e.g. Hush)
 *   add map <Name>     — append ONE new map's icon (e.g. Summit, #311)
 *
 * Why a separate tool from build-emoji-pack.ts: that script DELETES and
 * recreates the entire pack, which changes every `custom_emoji_id` and forces
 * a refresh of both rank-emoji.ts and valorant-emoji.ts. When Riot ships a
 * single new agent or map we only want to APPEND it — every existing id stays
 * valid, and we just paste the ONE new id into valorant-emoji.ts.
 *
 * Same conventions as build-emoji-pack.ts:
 *   - agents: valorant-api.com displayIcon → 100×100 PNG, fit: contain
 *   - maps:   valorant-api.com splash      → 100×100 PNG, fit: cover
 *   - Bot API via TELEGRAM_BOT_TOKEN, owner user id as the sticker owner
 *
 * IDEMPOTENT: a sticker in the set whose id is referenced nowhere in code is an
 * "orphan" — an append whose id has not been pasted yet. If one orphan of the
 * requested kind exists (agent alias 🦸, map alias 🗺️ — or ⛰️ from the old
 * add-map-emoji.ts), `add` assumes it is this one and prints its id instead of
 * adding a duplicate. So paste each id before appending the next agent/map.
 *
 * Usage (needs the bot token — run through 1Password):
 *   with-secrets bun scripts/launch/pack-emoji.ts check
 *   with-secrets bun scripts/launch/pack-emoji.ts add agent Hush
 *
 * After `add`, paste the printed line into src/server/publisher/valorant-emoji.ts
 * AGENT_EMOJI / MAP_EMOJI (key = name lowercased, non-alphanumerics stripped).
 */
import sharp from 'sharp';
import { AGENT_EMOJI, MAP_EMOJI, WEAPON_EMOJI } from '../../src/server/publisher/valorant-emoji.ts';
import { RANK_EMOJI } from '../../src/server/publisher/rank-emoji.ts';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN not set — run via: with-secrets bun scripts/launch/pack-emoji.ts …');
  process.exit(1);
}

const OWNER = 419486914; // bot owner's Telegram user id (matches build-emoji-pack.ts)
const NAME = 'valorant_npc_by_valorant_comunity_bot'; // the group's designated emoji pack

type Kind = 'agent' | 'map';
/** Alias emoji a fresh append is tagged with (same as build-emoji-pack.ts). */
const ADD_ALIAS: Record<Kind, string> = { agent: '🦸', map: '🗺️' };
/** Aliases that mark an orphan as this kind; ⛰️ is what add-map-emoji.ts used. */
const KIND_ALIASES: Record<Kind, string[]> = { agent: ['🦸'], map: ['🗺️', '⛰️'] };
const CODE_MAP: Record<Kind, Record<string, string>> = { agent: AGENT_EMOJI, map: MAP_EMOJI };
const CODE_MAP_NAME: Record<Kind, string> = { agent: 'AGENT_EMOJI', map: 'MAP_EMOJI' };

const t = token; // non-null within this module
const scrub = (s: string) => s.split(t).join('<token>');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Same slug rule as valorant-emoji.ts `norm` — lowercase, strip non-alphanumerics. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Telegram may drop the U+FE0F variation selector from a sticker's emoji. */
const sameEmoji = (a: string, b: string) => a.replace(/️/g, '') === b.replace(/️/g, '');

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

type Sticker = { custom_emoji_id: string; emoji: string };
async function packStickers(): Promise<Sticker[]> {
  const set = await api('getStickerSet', { name: NAME });
  if (!set.ok) throw new Error(`getStickerSet: ${scrub(JSON.stringify(set))}`);
  return set.result.stickers as Sticker[];
}

/** Every custom_emoji_id the code references, with a human label. */
function codeIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [k, id] of Object.entries(AGENT_EMOJI)) ids.set(id, `agent ${k}`);
  for (const [k, id] of Object.entries(MAP_EMOJI)) ids.set(id, `map ${k}`);
  for (const [k, id] of Object.entries(WEAPON_EMOJI)) ids.set(id, `weapon ${k}`);
  for (const [tier, r] of Object.entries(RANK_EMOJI)) ids.set(r.id, `rank ${tier}`);
  return ids;
}

/** valorant-api.com roster, same filters as build-emoji-pack.ts. */
async function valorantApi(kind: Kind): Promise<{ name: string; src: string }[]> {
  if (kind === 'agent') {
    const agents = (await getJson('https://valorant-api.com/v1/agents?isPlayableCharacter=true')).data as any[];
    return agents.filter((a) => a.displayIcon).map((a) => ({ name: a.displayName, src: a.displayIcon }));
  }
  const maps = (await getJson('https://valorant-api.com/v1/maps')).data as any[];
  return maps
    .filter((m) => m.displayName && m.displayIcon && (m.splash ?? m.listViewIcon)) // displayIcon gate keeps real maps only
    .map((m) => ({ name: m.displayName, src: m.splash ?? m.listViewIcon }));
}

async function tile(url: string, kind: Kind): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  const opts = kind === 'map'
    ? { fit: 'cover' as const, position: 'centre' as const }
    : { fit: 'contain' as const, background: { r: 0, g: 0, b: 0, alpha: 0 } };
  return sharp(Buffer.from(await r.arrayBuffer())).resize(100, 100, opts).png({ compressionLevel: 9 }).toBuffer();
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

async function check(): Promise<boolean> {
  let ok = true;
  const stickers = await packStickers();
  const inPack = new Set(stickers.map((s) => s.custom_emoji_id));
  const known = codeIds();
  console.log(`pack ${NAME}: ${stickers.length} stickers; code references ${known.size} ids`);

  const dead = [...known].filter(([id]) => !inPack.has(id));
  for (const [id, label] of dead) console.log(`  ✗ ${label}: id ${id} is NOT in the pack — renders as fallback`);
  if (dead.length) ok = false;
  else console.log('  ✓ every id in code exists in the pack');

  const orphans = stickers.filter((s) => !known.has(s.custom_emoji_id));
  for (const s of orphans) console.log(`  ! orphan in pack (${s.emoji}) ${s.custom_emoji_id} — appended but not pasted into code`);

  for (const kind of ['agent', 'map'] as const) {
    const missing = (await valorantApi(kind)).filter((x) => !CODE_MAP[kind][norm(x.name)]);
    for (const x of missing) console.log(`  ✗ ${kind} ${x.name} has no id in ${CODE_MAP_NAME[kind]} — run: add ${kind} ${x.name}`);
    if (missing.length) ok = false;
    else console.log(`  ✓ every valorant-api ${kind} has an id in ${CODE_MAP_NAME[kind]}`);
  }

  const chatId = process.env['TELEGRAM_PRIMARY_CHAT_ID'];
  if (!chatId) {
    console.log('  ? TELEGRAM_PRIMARY_CHAT_ID not set — skipped the group emoji-pack check');
  } else {
    const chat = await api('getChat', { chat_id: chatId });
    if (!chat.ok) throw new Error(`getChat: ${scrub(JSON.stringify(chat))}`);
    const groupPack = chat.result.custom_emoji_sticker_set_name;
    if (groupPack === NAME) console.log(`  ✓ group emoji pack is ${NAME}`);
    else {
      console.log(`  ✗ group emoji pack is ${groupPack ?? '(none)'}, not ${NAME} — icons fall back to unicode`);
      ok = false;
    }
  }
  return ok;
}

async function add(kind: Kind, wanted: string): Promise<void> {
  const slug = norm(wanted);
  if (!slug) throw new Error(`name "${wanted}" normalises to empty`);

  const roster = await valorantApi(kind);
  const asset = roster.find((x) => norm(x.name) === slug);
  if (!asset) throw new Error(`${kind} "${wanted}" not found on valorant-api.com (checked ${roster.length})`);
  console.log(`resolved ${asset.name} — ${asset.src}`);
  const line = (id: string) => `  ${slug}: '${id}', // ${asset.name}`;

  const before = await packStickers();
  const inPack = new Set(before.map((s) => s.custom_emoji_id));
  const inCode = CODE_MAP[kind][slug];
  if (inCode && inPack.has(inCode)) {
    console.log(`\n✅ ${asset.name} is already in the pack and in ${CODE_MAP_NAME[kind]} (${inCode}) — nothing to do.`);
    return;
  }

  const known = codeIds();
  const pending = before.filter(
    (s) => !known.has(s.custom_emoji_id) && KIND_ALIASES[kind].some((a) => sameEmoji(a, s.emoji)),
  );
  if (pending.length > 1) {
    throw new Error(`${pending.length} unpasted ${kind} orphans in the pack — paste or delete them before adding another`);
  }
  if (pending.length === 1) {
    console.log(`\n✅ an unpasted ${kind} sticker is already in the pack — assuming it is ${asset.name}, skipping add.`);
    console.log(`\nPaste into src/server/publisher/valorant-emoji.ts ${CODE_MAP_NAME[kind]}:\n\n${line(pending[0]!.custom_emoji_id)}`);
    return;
  }

  console.log(`normalising → 100×100 PNG …`);
  const fileId = await uploadSticker(await tile(asset.src, kind), `${slug}.png`);
  const added = await api('addStickerToSet', {
    user_id: OWNER,
    name: NAME,
    sticker: { sticker: fileId, format: 'static', emoji_list: [ADD_ALIAS[kind]] },
  });
  if (!added.ok) throw new Error(`addStickerToSet: ${scrub(JSON.stringify(added))}`);
  console.log(`added ${asset.name} to ${NAME}`);

  // The new sticker is the one id the pack did not have before.
  await sleep(1000);
  const fresh = (await packStickers()).find((s) => !inPack.has(s.custom_emoji_id));
  if (!fresh) throw new Error('could not find the new sticker in getStickerSet after addStickerToSet');

  console.log(`\n✅ ${asset.name} custom_emoji_id: ${fresh.custom_emoji_id}`);
  console.log(`\nPaste into src/server/publisher/valorant-emoji.ts ${CODE_MAP_NAME[kind]}:\n\n${line(fresh.custom_emoji_id)}`);
}

async function main(): Promise<void> {
  const [cmd, kind, name] = process.argv.slice(2);
  if (cmd === 'check') {
    if (!(await check())) process.exit(1);
    return;
  }
  if (cmd === 'add' && (kind === 'agent' || kind === 'map') && name) return add(kind, name);
  console.error('Usage: bun scripts/launch/pack-emoji.ts check | add <agent|map> <Name>   (e.g. add agent Hush)');
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
