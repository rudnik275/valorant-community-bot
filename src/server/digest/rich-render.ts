/**
 * rich-render.ts — Renderer for the weekly digest.
 *
 * ─── Format: FLAT LINES, no tables (owner, 2026-08-04) ──────────────────────
 *
 * The previous layout leaned on `<table>` for «Повышение по службе», «Мастера
 * своего дела», «Чаще всего играли на» and «Чаще всего пикали». Tables read
 * badly on a phone — narrow columns wrap, and the 3-column weapons table was
 * the worst offender — so every table is gone. Each section is now a header
 * line plus one line per item:
 *
 *   🔫 <b>Мастера своего дела</b>
 *   🔫 Vandal · 28 — <b>Ник#Тег</b>
 *
 * `<details>` accordions are gone for the same reason: the owner picked the
 * "всё видно сразу" variant, so records render as two flat lines (title, then
 * `ник · значение · ссылка-на-матч`) instead of a tap-to-expand summary. The
 * per-record context line («рекорд по количеству фрагов за игру») went with
 * them — it lived inside the accordion body and would have cost a visible line
 * per record in a flat layout.
 *
 * ─── One model, two renderings ──────────────────────────────────────────────
 *
 * `renderDigest` returns BOTH the Rich Message html and the plain-text
 * fallback from the SAME `RichDigestModel`. They differ only in how lines are
 * joined (`<br>` vs `\n`) and in html-only chrome (the `<h2>` title, the cover
 * `<img>`, the `<footer>`). Previously build.ts assembled the legacy text
 * through publisher/templates.ts while this module assembled the rich html
 * separately — two hand-synced formats that could drift. Now they cannot.
 *
 * Inline markup (`<b>/<i>/<u>/<a>/<tg-emoji>`) is valid in BOTH Rich Messages
 * and classic `parse_mode: 'HTML'`, so every line is shared verbatim.
 *
 * Rich HTML facts we rely on (verified against the live Bot API docs + spike
 * #306, PRs #307/#308/#310): `<h2>` renders as a heading, `<img src>` renders
 * an inline HTTP(S) image, inline markup passes through, and **raw `\n`
 * collapses browser-style** — so the html carries NO raw `\n` (asserted in
 * tests) while the text twin is built from the same lines with real newlines.
 */

import { renderPlayerName, matchLink } from '../publisher/player-render.ts';
import { rankToEmojiHtml } from '../publisher/rank-emoji.ts';
import type { AceKnifeStanding } from './ace-knife.ts';

/** A community player attached to a specific match (record events). */
export interface RichPlayerRef {
  /** Riot display name (unescaped). */
  name: string;
  /** Riot tag (unescaped). */
  tag: string;
  /** Rank label in that match (e.g. "Diamond 3"), or null when unknown. */
  rank?: string | null;
  /** Agent the player ran that match (e.g. "Jett"), or null when unknown. */
  agent?: string | null;
}

/** One record event rendered as a two-line flat block. */
export interface RichRecord {
  /** Leading unicode emoji for the title line (e.g. "💀"). */
  emoji: string;
  /** Record title (e.g. "Серийный маньяк"). Escaped at render. */
  title: string;
  /** Player attached to the record. */
  player: RichPlayerRef;
  /** Value line text (e.g. "38 фрагов", "4200 dmg"). Escaped at render. */
  value: string;
  /** Tracker match URL, or null for aggregate records (Король MVP). */
  matchUrl?: string | null;
  /** Map name of that match (drives the map emoji on the link). */
  mapName?: string | null;
  /**
   * Context description (e.g. "рекорд по количеству фрагов за игру").
   * Retained on the model — build.ts still fills it — but NOT rendered in the
   * flat layout (see the header note).
   */
  context: string;
}

/** Winstreak card row. */
export interface RichWinstreak {
  name: string;
  tag: string;
  streak: number;
}

/** One promotion row for «Повышение по службе». */
export interface RichPromotion {
  name: string;
  tag: string;
  /** Rank label reached (e.g. "Diamond 2"). Drives the rank emoji. */
  rank: string;
}

/** One structured weapon-master row for «Мастера своего дела». */
export interface RichWeaponMaster {
  /** Custom-emoji HTML for the weapon (or a unicode fallback marker). */
  weaponEmojiHtml: string;
  /** Weapon display name (already the DB/Henrik name; escaped at render). */
  weapon: string;
  /** Frag count. */
  value: number;
  /**
   * Player display, as a TRUSTED HTML fragment (already `<b>…</b>`-wrapped and
   * `esc()`-escaped by build.ts). Rendered verbatim into the line.
   */
  playerHtml: string;
}

/** One near-miss ("почти рекорд") block. */
export interface RichNearMiss {
  /** Leading unicode emoji (e.g. "💀"). */
  emoji: string;
  /** Underlined header (verbatim from near-miss-config). Escaped at render. */
  header: string;
  /** Player attached to the near-miss. */
  player: RichPlayerRef;
  /** Value + unit line (e.g. "29 фрагов"). Escaped at render. */
  value: string;
}

/**
 * One top-map row. No per-entry pack icon: the recap line is prefixed with a
 * single 🗺 and repeating a map icon per entry read as a doubled emoji.
 */
export interface RichTopMap {
  /** Map name (escaped at render). */
  map: string;
  /** Match count. */
  count: number;
}

/** One top-agent row. Same no-per-entry-icon rule as {@link RichTopMap}. */
export interface RichTopAgent {
  /** Agent name (escaped at render). */
  agent: string;
  /** Pick count. */
  count: number;
}

/**
 * Structured data for one weekly digest. Assembled in a single pass by
 * build.ts and rendered twice (html + text) by `renderDigest`.
 */
export interface RichDigestModel {
  /** Localised date for the title (e.g. "27 апреля 2025 г."). */
  headerDate: string;
  /** Most-played map name this week (topMap) — drives the cover image. */
  coverMap: string | null;
  /** Total matches this window (pulse line). */
  totalMatches: number;
  /** Record events, order-preserving. */
  records: RichRecord[];
  /** Winstreak rows. Empty ⇒ section omitted. */
  winstreaks: RichWinstreak[];
  /**
   * Ace leaderboard — «кто сколько эйсов сделал». Desc by count.
   * Empty ⇒ section omitted.
   */
  aces: AceKnifeStanding[];
  /**
   * Knife-kill leaderboard — «кто сколько ножей сделал». Desc by count.
   * Empty ⇒ section omitted.
   */
  knives: AceKnifeStanding[];
  /** Promotion rows. Empty ⇒ omitted. */
  promotions: RichPromotion[];
  /** Weapons-masters rows. Empty ⇒ omitted. */
  weaponMasters: RichWeaponMaster[];
  /** Near-miss blocks. Empty ⇒ «Почти рекорды» omitted. */
  nearMisses: RichNearMiss[];
  /**
   * Most-active player: `{ nameHtml, count }`, or null when omitted (<5).
   * `nameHtml` is a TRUSTED fragment (already `<b>…</b>`-wrapped + escaped by
   * build.ts) — rendered verbatim; do NOT re-escape.
   */
  mostActive: { nameHtml: string; count: number } | null;
  /** Top maps (already limited to 3, sorted desc). Empty ⇒ omitted. */
  topMaps: RichTopMap[];
  /** Top agents (already limited to 3, sorted desc). Empty ⇒ omitted. */
  topAgents: RichTopAgent[];
}

/** The two renderings of one digest, produced together from one model. */
export interface RenderedDigest {
  /** Rich Message html for `sendRichMessage`. Contains NO raw `\n`. */
  html: string;
  /** Plain-text fallback for `sendMessage` with `parse_mode: 'HTML'`. */
  text: string;
}

/**
 * Static map → valorant-api.com uuid table for the weekly cover splash.
 * Covers every map with a local asset in `src/assets/maps/` plus Summit
 * (#311). Each uuid verified against https://valorant-api.com/v1/maps
 * (fetched 2026-07-23). Unknown maps resolve to null ⇒ no cover image.
 */
const MAP_SPLASH_UUID: Record<string, string> = {
  abyss: '224b0a95-48b9-f703-1bd8-67aca101a61f',
  ascent: '7eaecc1b-4337-bbf6-6ab9-04b8f06b3319',
  bind: '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba',
  breeze: '2fb9a4fd-47b8-4e7d-a969-74b4046ebd53',
  corrode: '1c18ab1f-420d-0d8b-71d0-77ad3c439115',
  fracture: 'b529448b-4d60-346e-e89e-00a4c527a405',
  haven: '2bee0dc9-4ffe-519b-1cbd-7fbe763a6047',
  icebox: 'e2ad5c54-4114-a870-9641-8ea21279579a',
  lotus: '2fe4ed3a-450a-948b-6d6b-e89a78e680a9',
  pearl: 'fd267378-4d1d-484f-ff52-77821ed10dc2',
  split: 'd960549e-485c-e861-8d71-aa9d1aed12a2',
  summit: '756da597-416b-c0f2-f47b-afbdf28670bc',
  sunset: '92584fbe-486a-b1b2-9faa-39b0f486b498',
};

/** Normalise a map name to the splash-table key (lowercase, alnum only). */
function normMap(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve the cover-splash URL for a map name, or null when the map is
 * unknown to the static table (⇒ no `<img>` block).
 */
export function mapSplashUrl(map: string | null | undefined): string | null {
  if (!map) return null;
  const uuid = MAP_SPLASH_UUID[normMap(map)];
  return uuid ? `https://media.valorant-api.com/maps/${uuid}/splash.png` : null;
}

/** HTML-escape (same rules as publisher/templates.ts esc). */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Podium markers for the ace / knife leaderboards; 4th place onward gets a bullet. */
const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * One rendered section: a list of inline-HTML lines. Blocks are separated by a
 * blank line in both renderings; lines inside a block are not.
 */
type Block = string[];

/**
 * Render one ace/knife leaderboard block, or null when the board is empty.
 * Line shape: `🥇 <b>Ник#Тег</b> — 4` (+ ` (🪿 1)` when some knife kills hit an
 * AFK victim). Aces never carry a goose count.
 */
function standingsBlock(
  emoji: string,
  title: string,
  standings: AceKnifeStanding[],
): Block | null {
  if (standings.length === 0) return null;
  const lines = standings.map((s, i) => {
    const marker = MEDALS[i] ?? '•';
    const nick = renderPlayerName({ name: s.name, tag: s.tag, isCommunity: true });
    const geese = s.geese > 0 ? ` (🪿 ${s.geese})` : '';
    return `${marker} ${nick} — ${s.count}${geese}`;
  });
  return [`${emoji} <b>${title}</b>`, ...lines];
}

/**
 * Assemble every section of the digest as a list of blocks. Shared by both
 * renderings — the html/text split happens only at join time.
 */
function buildBlocks(model: RichDigestModel): Block[] {
  const blocks: Block[] = [];

  // 1. Pulse line.
  blocks.push([`📊 За неделю мы сыграли <b>${model.totalMatches}</b> матчей`]);

  // 2. Records — two flat lines each: title, then `ник · значение · ссылка`.
  for (const r of model.records) {
    const nick = renderPlayerName({
      name: r.player.name,
      tag: r.player.tag,
      isCommunity: true,
      rank: r.player.rank ?? null,
      agent: r.player.agent ?? null,
    });
    const parts = [nick, esc(r.value)];
    if (r.matchUrl) {
      parts.push(matchLink({ url: r.matchUrl, mapName: r.mapName ?? null }));
    }
    blocks.push([`${r.emoji} <b>${esc(r.title)}</b>`, parts.join(' · ')]);
  }

  // 3. Ace / knife leaderboards — the former daily digest, now plain counts.
  const aceBlock = standingsBlock('🎯', 'Эйсы недели', model.aces);
  if (aceBlock) blocks.push(aceBlock);
  const knifeBlock = standingsBlock('🔪', 'Ножи недели', model.knives);
  if (knifeBlock) blocks.push(knifeBlock);

  // 4. Винстрик недели.
  if (model.winstreaks.length > 0) {
    const lines = model.winstreaks
      .slice()
      .sort((a, b) => b.streak - a.streak)
      .map(
        (w) =>
          `${renderPlayerName({ name: w.name, tag: w.tag, isCommunity: true })}` +
          ` · ${w.streak} побед подряд`,
      );
    blocks.push(['🏆 <b>Винстрик недели</b>', ...lines]);
  }

  // 5. Мастера своего дела — one line per weapon (was a 3-column table).
  if (model.weaponMasters.length > 0) {
    const lines = model.weaponMasters.map(
      (w) =>
        `${w.weaponEmojiHtml ? `${w.weaponEmojiHtml} ` : ''}${esc(w.weapon)}` +
        ` · ${w.value} — ${w.playerHtml}`,
    );
    blocks.push([
      '🔫 <b>Мастера своего дела</b>',
      '<i>лидеры по убийствам одним оружием за матч</i>',
      ...lines,
    ]);
  }

  // 6. Повышение по службе — one line per player (was a table).
  if (model.promotions.length > 0) {
    const lines = model.promotions.map((p) => {
      const nick = renderPlayerName({ name: p.name, tag: p.tag, isCommunity: true });
      const rankEmoji = rankToEmojiHtml(p.rank);
      return `${nick} → ${rankEmoji || esc(p.rank)}`;
    });
    const header = model.promotions.length === 1 ? 'Повышение по службе' : 'Повышения по службе';
    blocks.push([`🎖 <b>${header}</b>`, ...lines]);
  }

  // 7. Почти рекорды.
  for (const nm of model.nearMisses) {
    const nick = renderPlayerName({
      name: nm.player.name,
      tag: nm.player.tag,
      isCommunity: true,
      agent: nm.player.agent ?? null,
    });
    blocks.push([`${nm.emoji} <u>${esc(nm.header)}</u>`, `${nick} · ${esc(nm.value)}`]);
  }

  // 8. Больше всех матчей.
  if (model.mostActive) {
    blocks.push([
      '🏆 <b>Больше всех матчей</b>',
      `${model.mostActive.nameHtml} · ${model.mostActive.count} за неделю`,
    ]);
  }

  // 9. Карты и агенты — one inline line each instead of two tables.
  //
  // The per-entry custom map/agent icons are deliberately NOT used here. A
  // leading 🗺 / 🎭 already labels the row, and repeating an icon per entry
  // read as a doubled emoji («🗺 🗺️ Ascent 14 · 🗺️ Bind 10»). The pack icons
  // still ride along everywhere they carry information — next to nicks, ranks,
  // agents, weapons and match links.
  if (model.topMaps.length > 0) {
    const inline = model.topMaps.map((m) => `${esc(m.map)} ${m.count}`).join(' · ');
    blocks.push([`🗺 ${inline}`]);
  }
  if (model.topAgents.length > 0) {
    const inline = model.topAgents.map((a) => `${esc(a.agent)} ${a.count}`).join(' · ');
    blocks.push([`🎭 ${inline}`]);
  }

  return blocks;
}

/**
 * Render the weekly digest once into both a Rich Message html string and the
 * plain-text fallback.
 *
 * The html carries NO raw `\n` (every break is `<br>` or block markup) — the
 * digest otherwise collapses in the rich client. The text twin uses real
 * newlines and drops html-only chrome (cover image, `<h2>`, `<footer>`).
 */
export function renderDigest(model: RichDigestModel): RenderedDigest {
  const blocks = buildBlocks(model);

  // ── Rich html ──
  const htmlParts: string[] = [`<h2>📅 Дайджест за неделю · ${esc(model.headerDate)}</h2>`];
  const coverUrl = mapSplashUrl(model.coverMap);
  if (coverUrl) htmlParts.push(`<img src="${esc(coverUrl)}">`);
  htmlParts.push(blocks.map((b) => b.join('<br>')).join('<br><br>'));
  htmlParts.push('<footer>#digest</footer>');

  // ── Plain text twin ──
  const textParts: string[] = [`📅 <b>Дайджест за неделю · ${esc(model.headerDate)}</b>`];
  textParts.push(blocks.map((b) => b.join('\n')).join('\n\n'));
  textParts.push('#digest');

  return {
    html: htmlParts.join(''),
    text: textParts.join('\n\n'),
  };
}
