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

import { renderPlayerName } from '../publisher/player-render.ts';
import { rankToEmojiHtml } from '../publisher/rank-emoji.ts';
import { mapToEmojiHtml } from '../publisher/valorant-emoji.ts';
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
   * Most-active player(s) of the week, or null when omitted (<5 matches).
   * `namesHtml` holds EVERY player on the winning match count — a tie used to
   * silently drop all but one arbitrary SQL row. They share one `count` by
   * definition. Each entry is a TRUSTED fragment (already `<b>…</b>`-wrapped +
   * escaped by build.ts) — rendered verbatim; do NOT re-escape.
   */
  mostActive: { namesHtml: string[]; count: number } | null;
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

/**
 * Match link for a RICH message. Deliberately not the shared `matchLink`
 * helper: in a Rich Message an `<a>` whose content includes a `<tg-emoji>`
 * does not render as a tappable link (owner screenshot, 2026-08-04 — the map
 * name came out plain black), while the identical markup links fine in a
 * normal `sendMessage`. So here the icon sits OUTSIDE the anchor and only the
 * map name is linked.
 */
function richMatchLink(url: string, mapName: string | null): string {
  const icon = mapName ? mapToEmojiHtml(mapName) : '';
  const label = mapName ? esc(mapName) : 'матч';
  return `${icon ? `${icon} ` : ''}<a href="${esc(url)}">${label}</a>`;
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
 * Ceiling on visible rows when a tie group straddles the podium edge. A board
 * whose whole tie group still fits under this renders open (everyone tied is
 * shown); past it the tie group folds away wholesale instead.
 */
const MAX_VISIBLE = PODIUM + 5;

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
 * A section: header (plus an optional italic description) — BLANK LINE — body.
 *
 * The blank line is owner-requested: a heading sitting flush against its own
 * numbers read as one cramped clump. When a heading carries a description the
 * gap goes AFTER the description, so heading and description stay together.
 *
 * An empty string is just another line; joined with `<br>` it yields the blank
 * line in the rich rendering and a real one in the text twin.
 */
function section(header: string[], body: string[]): Block {
  return { lines: [...header, '', ...body] };
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
  const places = placesFor(rows);
  const rendered = rows.map(
    (r, i) => `${MEDALS[places[i]! - 1] ?? '•'} ${r.labelHtml} — ${r.count}`,
  );

  // Podium stays open, the tail folds away. The `tail.length > 1` bound means
  // the tail is always ≥ 2 rows, so an accordion is never empty and never hides
  // a single line (which would cost more than it saves). A board that fits in
  // the podium renders wholly open.
  const cut = collapse ? tieSafeCut(rows.map((r) => r.count), collapse.after) : rows.length;
  if (collapse && cut < rendered.length && rendered.length - cut > 1) {
    const tail = rendered.slice(cut);
    return {
      ...section([`${emoji} <b>${title}</b>`], rendered.slice(0, cut)),
      more: { summary: collapse.summary(tail.length), lines: tail },
    };
  }
  return section([`${emoji} <b>${title}</b>`], rendered);
}

/**
 * Competition ranking ("1224") over a desc-sorted board: equal counts share a
 * place and the next distinct count skips the places they consumed. Returns the
 * 1-based place of each row.
 *
 * Positional medals (`MEDALS[i]`) handed 🥉 to whichever of six players tied on
 * one ace happened to sort third and buried the other five in the accordion —
 * the placement was an artefact of the sort, not of the week (owner, 2026-08-09).
 */
function placesFor(rows: Array<{ count: number }>): number[] {
  const places: number[] = [];
  let place = 1;
  rows.forEach((r, i) => {
    if (i > 0 && r.count !== rows[i - 1]!.count) place = i + 1;
    places.push(place);
  });
  return places;
}

/**
 * Where to cut a desc-sorted board into visible rows + collapsed tail so the
 * cut NEVER falls inside a tie group — showing three of six players tied on one
 * ace is the bug this exists to prevent.
 *
 * Cuts are only legal at a count change. Preferred: the first legal cut at or
 * after `after` (the tie group straddling the podium edge stays fully visible),
 * as long as that keeps the board under {@link MAX_VISIBLE}. Otherwise the
 * straddling group folds away wholesale — the last legal cut at or before
 * `after`. When neither exists the board renders open: a cut inside a tie group
 * is never worth it, and hiding every row would leave the section empty.
 */
function tieSafeCut(counts: number[], after: number): number {
  const boundaries: number[] = [];
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] !== counts[i - 1]) boundaries.push(i);
  }
  // No boundary past `after` ⇒ the last group runs to the end; the whole board
  // is then one legal "cut" at its length (i.e. render everything open).
  const forward = boundaries.find((b) => b >= after) ?? counts.length;
  if (forward <= MAX_VISIBLE) return forward;
  // Too many to show. Fold the straddling group away if we can cut before it;
  // otherwise fall back to `forward` — an over-long open board still beats
  // rendering every row open, which is what returning `counts.length` here
  // would do whenever a big tie group sits in the middle of the table.
  const backward = [...boundaries].reverse().find((b) => b <= after);
  return backward ?? forward;
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
  // Section order is owner-specified (2026-08-04):
  //   пульс → больше всех матчей → винстрик → рекорды → почти рекорды →
  //   повышения → мастера своего дела → эйсы → ножи → карты → агенты
  // «Больше всех матчей» leads because it reads straight off the pulse line
  // («сыграли 478» → «больше всех — Госпожа, 68»); the two aggregate boards
  // close the post. Reordering means moving whole blocks here — nothing else
  // depends on the sequence, and `section-order` in the tests locks it.
  const blocks: Block[] = [];

  /** Push a header-then-body section (blank line inserted between). */
  const push = (header: string, ...body: string[]): void => {
    blocks.push(section([header], body));
  };

  // 1. Pulse line — a standalone line, no body, so no blank after it.
  blocks.push({ lines: [`📊 За неделю мы сыграли <b>${model.totalMatches}</b> матчей`] });

  // 2. Больше всех матчей — one line per player, so a tie shows everyone.
  if (model.mostActive && model.mostActive.namesHtml.length > 0) {
    const { namesHtml, count } = model.mostActive;
    push(
      '🏆 <b>Больше всех матчей</b>',
      ...namesHtml.map((nameHtml) => `${nameHtml} · ${count} за неделю`),
    );
  }

  // 3. Винстрик недели.
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

  // 4. Records — two flat lines each: title, then `ник · значение · ссылка`.
  // One block per award, never more: build.ts already collapses a week-long
  // chain of record breaks to its best entry, and this map is the last line of
  // defence so a record type that slips past that (as 🐴/⚓ did — four «Троянский
  // конь» blocks in one digest, owner 2026-08-09) still cannot render twice.
  // The LAST entry of a duplicated award wins, keeping its position: entries
  // arrive in detected_at order, so within a chain of record breaks the last one
  // is the standing record. Keeping the first would have shown «1 первых
  // смертей» while hiding the real 9.
  const recordSlots = new Map<string, RichRecord>();
  for (const r of model.records) recordSlots.set(`${r.emoji}|${r.title}`, r);
  for (const r of recordSlots.values()) {
    const nick = renderPlayerName({
      name: r.player.name,
      tag: r.player.tag,
      isCommunity: true,
      rank: r.player.rank ?? null,
      agent: r.player.agent ?? null,
    });
    const parts = [nick, esc(r.value)];
    if (r.matchUrl) {
      parts.push(richMatchLink(r.matchUrl, r.mapName ?? null));
    }
    push(`${r.emoji} <b>${esc(r.title)}</b>`, parts.join(' · '));
  }

  // 5. Почти рекорды.
  for (const nm of model.nearMisses) {
    const nick = renderPlayerName({
      name: nm.player.name,
      tag: nm.player.tag,
      isCommunity: true,
      agent: nm.player.agent ?? null,
    });
    const nmLink = nm.matchUrl ? ` · ${richMatchLink(nm.matchUrl, nm.mapName ?? null)}` : '';
    push(`${nm.emoji} <u>${esc(nm.header)}</u>`, `${nick} · ${esc(nm.value)}${nmLink}`);
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

  // 7. Мастера своего дела — one line per weapon (was a 3-column table).
  if (model.weaponMasters.length > 0) {
    const lines = model.weaponMasters.map((w) => {
      const link = w.matchUrl ? ` · ${richMatchLink(w.matchUrl, w.mapName ?? null)}` : '';
      return (
        `${w.weaponEmojiHtml ? `${w.weaponEmojiHtml} ` : ''}${esc(w.weapon)}` +
        ` · ${w.value} — ${w.playerHtml}${link}`
      );
    });
    // Two header lines — the gap goes after the description, not before it.
    blocks.push(
      section(
        ['🔫 <b>Мастера своего дела</b>', '<i>лидеры по убийствам одним оружием за матч</i>'],
        lines,
      ),
    );
  }

  // 8. Ace / knife leaderboards — the former daily digest, now plain counts.
  // Same podium-plus-accordion treatment as maps/agents: on a busy week these
  // reach a dozen players and the tail is everyone with a single ace.
  const aceBlock = leaderboardBlock('🎯', 'Эйсы недели', standingsRows(model.aces), PLAYER_TAIL);
  if (aceBlock) blocks.push(aceBlock);
  const knifeBlock = leaderboardBlock('🔪', 'Ножи недели', standingsRows(model.knives), PLAYER_TAIL);
  if (knifeBlock) blocks.push(knifeBlock);

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
  // Sections are separated by a blank line — EXCEPT after an accordion.
  // `<details>` renders with its own margins and a divider rule, so the extra
  // `<br><br>` stacked on top of that left a visibly huge hole (owner screenshot).
  const rendered: string[] = [];
  blocks.forEach((b, i) => {
    const head = b.lines.join('<br>');
    // Belt-and-braces: an accordion with nothing inside is worse than no
    // accordion, so an empty tail is dropped regardless of how it was built.
    const hasMore = !!b.more && b.more.lines.length > 0;
    rendered.push(
      hasMore
        ? `${head}<details><summary>${esc(b.more!.summary)}</summary>${b.more!.lines.join('<br>')}</details>`
        : head,
    );
    if (i < blocks.length - 1) rendered.push(hasMore ? '' : '<br><br>');
  });
  htmlParts.push(rendered.join(''));
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
