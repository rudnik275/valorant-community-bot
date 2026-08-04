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
  /** Tracker URL of the match the record was set in. null ⇒ link omitted. */
  matchUrl?: string | null;
  /** Map of that match (drives the link label). */
  mapName?: string | null;
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
  /** Tracker URL of the match it happened in. null ⇒ link omitted. */
  matchUrl?: string | null;
  /** Map of that match (drives the link label). */
  mapName?: string | null;
}

/** One map row: pack icon PLUS the name (owner, 2026-08-04). */
export interface RichTopMap {
  /** Custom-emoji HTML for the map, or '' when the pack has no icon. */
  emojiHtml: string;
  /** Map name (escaped at render). */
  map: string;
  /** Match count. */
  count: number;
}

/**
 * One agent row. The pack icon REPLACES the name (owner, 2026-08-04) — agent
 * portraits are recognisable enough on their own and it keeps a ~28-row board
 * narrow. Agents missing from the pack (newer releases) fall back to the name,
 * so a row is never blank.
 */
export interface RichTopAgent {
  /** Custom-emoji HTML for the agent, or '' when the pack has no icon. */
  emojiHtml: string;
  /** Agent name (escaped at render; also the fallback label). */
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
  /**
   * EVERY map played this window, sorted desc by match count (owner asked for
   * «топ всех карт», not a top-3). Empty ⇒ section omitted.
   */
  topMaps: RichTopMap[];
  /**
   * EVERY agent picked this window, sorted desc. Note this is naturally long —
   * a real week sees ~28 distinct agents with a long 1-2 pick tail.
   * Empty ⇒ section omitted.
   */
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

/** Podium markers; 4th place onward gets a bullet. */
const MEDALS = ['🥇', '🥈', '🥉'];

/** How many rows stay visible above a collapsed tail. */
const PODIUM = 3;

/**
 * Russian plural for a count: 1 карта / 2 карты / 5 карт.
 * (11-14 take the genitive-plural form despite ending in 1-4.)
 */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Collapse config for the two player boards (aces, knives). */
const PLAYER_TAIL = {
  after: PODIUM,
  summary: (n: number) => `ещё ${n} ${pluralRu(n, 'игрок', 'игрока', 'игроков')}`,
};

/**
 * One rendered section.
 *
 * `lines` are always visible. `more` is an optional tail that the rich
 * rendering hides behind a `<details>` accordion — used for the long map /
 * agent boards, where the podium is the interesting part and the tail is a
 * list of one-pick agents. The plain-text twin has no accordions, so it simply
 * appends the tail (it is a send-failure fallback and the promo-image prompt
 * input, where completeness beats brevity).
 *
 * Blocks are separated by a blank line in both renderings; lines inside a
 * block are not.
 */
interface Block {
  lines: string[];
  more?: { summary: string; lines: string[] };
}

/**
 * ONE board shape for every ranked list in the digest — aces, knives, maps,
 * agents. Header line, then `<медаль|•> подпись — N` per row, desc-sorted by
 * the caller.
 *
 * `labelHtml` is a TRUSTED fragment (a rendered nick, or an already-escaped
 * name) and goes in verbatim. Returns null for an empty board so the caller
 * can drop the section entirely.
 */
function leaderboardBlock(
  emoji: string,
  title: string,
  rows: Array<{ labelHtml: string; count: number }>,
  collapse?: { after: number; summary: (hidden: number) => string },
): Block | null {
  if (rows.length === 0) return null;
  const rendered = rows.map((r, i) => `${MEDALS[i] ?? '•'} ${r.labelHtml} — ${r.count}`);

  // Podium stays open, the tail folds away. The `> after + 1` bound means the
  // tail is always ≥ 2 rows, so an accordion is never empty and never hides a
  // single line (which would cost more than it saves). A board that fits in
  // the podium renders wholly open.
  if (collapse && rendered.length > collapse.after + 1) {
    const tail = rendered.slice(collapse.after);
    return {
      lines: [`${emoji} <b>${title}</b>`, ...rendered.slice(0, collapse.after)],
      more: { summary: collapse.summary(tail.length), lines: tail },
    };
  }
  return { lines: [`${emoji} <b>${title}</b>`, ...rendered] };
}

/** Ace/knife board rows: the label is the player's rendered nick. */
function standingsRows(standings: AceKnifeStanding[]): Array<{ labelHtml: string; count: number }> {
  return standings.map((s) => ({
    labelHtml: renderPlayerName({ name: s.name, tag: s.tag, isCommunity: true }),
    count: s.count,
  }));
}

/**
 * Assemble every section of the digest as a list of blocks. Shared by both
 * renderings — the html/text split happens only at join time.
 */
function buildBlocks(model: RichDigestModel): Block[] {
  const blocks: Block[] = [];

  /** Push a section made of always-visible lines. */
  const push = (...lines: string[]): void => {
    blocks.push({ lines });
  };

  // 1. Pulse line.
  push(`📊 За неделю мы сыграли <b>${model.totalMatches}</b> матчей`);

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
    push(`${r.emoji} <b>${esc(r.title)}</b>`, parts.join(' · '));
  }

  // 3. Ace / knife leaderboards — the former daily digest, now plain counts.
  // Same podium-plus-accordion treatment as maps/agents: on a busy week these
  // reach a dozen players and the tail is everyone with a single ace.
  const aceBlock = leaderboardBlock('🎯', 'Эйсы недели', standingsRows(model.aces), PLAYER_TAIL);
  if (aceBlock) blocks.push(aceBlock);
  const knifeBlock = leaderboardBlock('🔪', 'Ножи недели', standingsRows(model.knives), PLAYER_TAIL);
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
    push('🏆 <b>Винстрик недели</b>', ...lines);
  }

  // 5. Мастера своего дела — one line per weapon (was a 3-column table).
  if (model.weaponMasters.length > 0) {
    const lines = model.weaponMasters.map((w) => {
      const link = w.matchUrl
        ? ` · ${matchLink({ url: w.matchUrl, mapName: w.mapName ?? null })}`
        : '';
      return (
        `${w.weaponEmojiHtml ? `${w.weaponEmojiHtml} ` : ''}${esc(w.weapon)}` +
        ` · ${w.value} — ${w.playerHtml}${link}`
      );
    });
    push(
      '🔫 <b>Мастера своего дела</b>',
      '<i>лидеры по убийствам одним оружием за матч</i>',
      ...lines,
    );
  }

  // 6. Повышение по службе — one line per player (was a table).
  if (model.promotions.length > 0) {
    const lines = model.promotions.map((p) => {
      const nick = renderPlayerName({ name: p.name, tag: p.tag, isCommunity: true });
      const rankEmoji = rankToEmojiHtml(p.rank);
      return `${nick} → ${rankEmoji || esc(p.rank)}`;
    });
    const header = model.promotions.length === 1 ? 'Повышение по службе' : 'Повышения по службе';
    push(`🎖 <b>${header}</b>`, ...lines);
  }

  // 7. Почти рекорды.
  for (const nm of model.nearMisses) {
    const nick = renderPlayerName({
      name: nm.player.name,
      tag: nm.player.tag,
      isCommunity: true,
      agent: nm.player.agent ?? null,
    });
    const nmLink = nm.matchUrl
      ? ` · ${matchLink({ url: nm.matchUrl, mapName: nm.mapName ?? null })}`
      : '';
    push(`${nm.emoji} <u>${esc(nm.header)}</u>`, `${nick} · ${esc(nm.value)}${nmLink}`);
  }

  // 8. Больше всех матчей.
  if (model.mostActive) {
    push(
      '🏆 <b>Больше всех матчей</b>',
      `${model.mostActive.nameHtml} · ${model.mostActive.count} за неделю`,
    );
  }

  // 9. Карты и агенты — full boards in the ace/knife shape, but with the tail
  // folded into a `<details>` (owner: «топ3 показывать, остальное в
  // аккордеон»). A real week is ~7 maps and ~28 agents, so the podium carries
  // the signal and the one-pick tail would otherwise be ~25 lines of noise.
  // Maps show icon + name; agents show the icon alone.
  const mapsBlock = leaderboardBlock(
    '🗺',
    'Карты недели',
    model.topMaps.map((m) => ({
      labelHtml: `${m.emojiHtml ? `${m.emojiHtml} ` : ''}${esc(m.map)}`,
      count: m.count,
    })),
    { after: PODIUM, summary: (n) => `ещё ${n} ${pluralRu(n, 'карта', 'карты', 'карт')}` },
  );
  if (mapsBlock) blocks.push(mapsBlock);

  const agentsBlock = leaderboardBlock(
    '🎭',
    'Агенты недели',
    // Icon INSTEAD of the name; agents the pack doesn't cover keep their name
    // so the row never renders blank.
    model.topAgents.map((a) => ({ labelHtml: a.emojiHtml || esc(a.agent), count: a.count })),
    { after: PODIUM, summary: (n) => `ещё ${n} ${pluralRu(n, 'агент', 'агента', 'агентов')}` },
  );
  if (agentsBlock) blocks.push(agentsBlock);

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
  htmlParts.push(
    blocks
      .map((b) => {
        const head = b.lines.join('<br>');
        // Belt-and-braces: an accordion with nothing inside is worse than no
        // accordion, so an empty tail is dropped here regardless of how the
        // block was built.
        if (!b.more || b.more.lines.length === 0) return head;
        // `<details>` is block-level, so no <br> before it.
        return `${head}<details><summary>${esc(b.more.summary)}</summary>${b.more.lines.join('<br>')}</details>`;
      })
      .join('<br><br>'),
  );
  htmlParts.push('<footer>#digest</footer>');

  // ── Plain text twin ──
  const textParts: string[] = [`📅 <b>Дайджест за неделю · ${esc(model.headerDate)}</b>`];
  // No accordions in plain text — the tail is simply listed.
  textParts.push(
    blocks.map((b) => [...b.lines, ...(b.more?.lines ?? [])].join('\n')).join('\n\n'),
  );
  textParts.push('#digest');

  return {
    html: htmlParts.join(''),
    text: textParts.join('\n\n'),
  };
}
