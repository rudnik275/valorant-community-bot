/**
 * rich-render.ts — Rich Message (Bot API 10.1+) renderer for the weekly digest.
 *
 * The weekly digest is built once (see build.ts) into a structured
 * `RichDigestModel`; `renderRichDigest` turns that model into the `html` string
 * for `sendRichMessage`. The legacy plain-text rendering is byte-for-byte
 * unchanged (build.ts still produces it verbatim) — this module is a PARALLEL
 * renderer over the same section data.
 *
 * Approved layout (#315 «Недельный дайджест», owner-approved via #309 previews):
 *   <h2>📅 Дайджест за неделю · дата</h2>
 *   <img src="…splash.png">                       (cover; only when topMap known)
 *   📊 За неделю мы сыграли <b>N</b> матчей
 *   <details>…</details> per record event          (bright records incl. MVP king)
 *   🏆 <b>Винстрик недели:</b> card               (no details, no match link)
 *   <h3>🎖 Повышение по службе</h3> + table Игрок|Ранг
 *   <h3>🔫 Мастера своего дела</h3> + table Оружие|Фраги|Игрок
 *   near-miss OPEN blocks (эмодзи <u>…</u><br>renderPlayerName · значение единица)
 *   🏆 <b>Больше всех матчей</b> line
 *   <h3>🗺 Чаще всего играли на</h3> + table Карта|Матчей
 *   <h3>🎭 Чаще всего пикали</h3>   + table Агент|Пиков
 *   <footer>#digest</footer>
 *
 * Rich HTML facts we rely on (verified against the live Bot API docs + spike
 * #306, PRs #307/#308/#310):
 *   - `<h2>`/`<h3>` render as headings; `<table>`/`<tr>/<th>/<td>` render as
 *     tables (custom `<tg-emoji>` survives inside cells; `align`/`striped`
 *     attributes pass through); `<details><summary>` renders collapsible;
 *     `<img src>` renders an inline HTTP(S) image.
 *   - Inline `<b>/<i>/<u>/<a>` and `<tg-emoji>` markup pass through untouched.
 *   - **Raw `\n` collapses browser-style** — the produced html carries NO raw
 *     `\n`; every break is `<br>` or block markup. Enforced + asserted in tests.
 *
 * The player-name / match-link rendering goes through the shared publisher
 * helpers (`renderPlayerName`, `matchLink`) landed in slice A (#316).
 */

import { renderPlayerName, matchLink } from '../publisher/player-render.ts';
import { rankToEmojiHtml } from '../publisher/rank-emoji.ts';

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

/** One record event rendered as a `<details>` accordion. */
export interface RichRecord {
  /** Leading unicode emoji for the summary (e.g. "💀"). */
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
  /** Context description (verbatim from templates). Escaped at render. */
  context: string;
}

/** Winstreak card row. */
export interface RichWinstreak {
  name: string;
  tag: string;
  streak: number;
}

/** One promotion row for the «Повышение по службе» table. */
export interface RichPromotion {
  name: string;
  tag: string;
  /** Rank label reached (e.g. "Diamond 2"). Drives the rank emoji. */
  rank: string;
}

/** One structured weapon-master row for the «Мастера своего дела» table. */
export interface RichWeaponMaster {
  /** Custom-emoji HTML for the weapon (or a unicode fallback marker). */
  weaponEmojiHtml: string;
  /** Weapon display name (already the DB/Henrik name; escaped at render). */
  weapon: string;
  /** Frag count. */
  value: number;
  /**
   * Player display, as a TRUSTED HTML fragment (already `<b>…</b>`-wrapped and
   * `esc()`-escaped by build.ts). Rendered verbatim into the cell.
   */
  playerHtml: string;
}

/** One near-miss ("почти рекорд") OPEN block. */
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

/** One structured top-map row for the «Чаще всего играли на» table. */
export interface RichTopMap {
  /** Custom-emoji HTML for the map, or '' when unknown. */
  emojiHtml: string;
  /** Map name (escaped at render). */
  map: string;
  /** Match count. */
  count: number;
}

/** One structured top-agent row for the «Чаще всего пикали» table. */
export interface RichTopAgent {
  /** Custom-emoji HTML for the agent, or '' when unknown. */
  emojiHtml: string;
  /** Agent name (escaped at render). */
  agent: string;
  /** Pick count. */
  count: number;
}

/**
 * Structured data for the rich rendering of one weekly digest. Assembled in
 * the same pass as the legacy text (build.ts). Every field mirrors a legacy
 * section so nothing drifts.
 */
export interface RichDigestModel {
  /** Localised date for the `<h2>` title (e.g. "27 апреля 2025 г."). */
  headerDate: string;
  /** Most-played map name this week (topMap) — drives the cover image. */
  coverMap: string | null;
  /** Total matches this window (pulse line). */
  totalMatches: number;
  /** Record events rendered as `<details>` accordions (order-preserving). */
  records: RichRecord[];
  /** Winstreak rows for the «Винстрик недели» card. Empty ⇒ card omitted. */
  winstreaks: RichWinstreak[];
  /** Promotion rows for the «Повышение по службе» table. Empty ⇒ omitted. */
  promotions: RichPromotion[];
  /** Weapons-masters rows for the «Мастера своего дела» table. Empty ⇒ omitted. */
  weaponMasters: RichWeaponMaster[];
  /** Near-miss OPEN blocks. Empty ⇒ «Почти рекорды» omitted. */
  nearMisses: RichNearMiss[];
  /**
   * Most-active player: `{ nameHtml, count }`, or null when omitted (<5).
   * `nameHtml` is a TRUSTED fragment (already `<b>…</b>`-wrapped + escaped by
   * build.ts) — rendered verbatim; do NOT re-escape.
   */
  mostActive: { nameHtml: string; count: number } | null;
  /** Top maps (already limited to 3, sorted desc). Empty ⇒ section omitted. */
  topMaps: RichTopMap[];
  /** Top agents (already limited to 3, sorted desc). Empty ⇒ section omitted. */
  topAgents: RichTopAgent[];
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

/**
 * Render one record event as a `<details>` accordion:
 *   <details><summary>эмодзи <b>Название</b><br>
 *     renderPlayerName · значение · matchLink</summary>
 *     <blockquote><i>контекст</i></blockquote></details>
 * Aggregate records (no matchUrl) omit the match-link segment.
 */
function renderRecord(r: RichRecord): string {
  const nameHtml = renderPlayerName({
    name: r.player.name,
    tag: r.player.tag,
    isCommunity: true,
    rank: r.player.rank ?? null,
    agent: r.player.agent ?? null,
  });
  const parts = [nameHtml, esc(r.value)];
  if (r.matchUrl) {
    parts.push(matchLink({ url: r.matchUrl, mapName: r.mapName ?? null }));
  }
  const summary = `${r.emoji} <b>${esc(r.title)}</b><br>${parts.join(' · ')}`;
  const body = `<blockquote><i>${esc(r.context)}</i></blockquote>`;
  return `<details><summary>${summary}</summary>${body}</details>`;
}

/**
 * Render the weekly digest as Rich HTML for `sendRichMessage`.
 *
 * The produced string contains NO raw `\n` (every break is `<br>` or block
 * markup) — the digest text otherwise collapses in the rich client.
 */
export function renderRichDigest(model: RichDigestModel): string {
  const parts: string[] = [];

  // 1. Title.
  parts.push(`<h2>📅 Дайджест за неделю · ${esc(model.headerDate)}</h2>`);

  // 2. Cover image — splash of the week's top map (omitted when unknown).
  const coverUrl = mapSplashUrl(model.coverMap);
  if (coverUrl) {
    parts.push(`<img src="${esc(coverUrl)}">`);
  }

  // 3. Pulse line.
  parts.push(`📊 За неделю мы сыграли <b>${model.totalMatches}</b> матчей`);

  // 4. Records — one <details> accordion each.
  for (const r of model.records) {
    parts.push(renderRecord(r));
  }

  // 5. Винстрик недели — card without details.
  if (model.winstreaks.length > 0) {
    const lines = model.winstreaks
      .slice()
      .sort((a, b) => b.streak - a.streak)
      .map(
        (w) =>
          `${renderPlayerName({ name: w.name, tag: w.tag, isCommunity: true })}` +
          ` · ${w.streak} побед подряд`,
      );
    parts.push(`🏆 <b>Винстрик недели:</b><br>${lines.join('<br>')}`);
  }

  // 6. Повышение по службе — table Игрок | Ранг.
  if (model.promotions.length > 0) {
    const rows = model.promotions
      .map((p) => {
        const player = renderPlayerName({ name: p.name, tag: p.tag, isCommunity: true });
        const rankEmoji = rankToEmojiHtml(p.rank);
        const rankCell = rankEmoji || esc(p.rank);
        return `<tr><td>${player}</td><td>${rankCell}</td></tr>`;
      })
      .join('');
    parts.push(
      '<h3>🎖 Повышение по службе</h3>' +
        '<table><tr><th>Игрок</th><th>Ранг</th></tr>' +
        rows +
        '</table>',
    );
  }

  // 7. Мастера своего дела — striped weapons table.
  if (model.weaponMasters.length > 0) {
    const rows = model.weaponMasters
      .map(
        (w) =>
          `<tr><td>${w.weaponEmojiHtml} ${esc(w.weapon)}</td>` +
          `<td align="right">${w.value}</td>` +
          `<td>${w.playerHtml}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🔫 Мастера своего дела</h3>' +
        '<i>лидеры по убийствам одним оружием за матч</i>' +
        '<table striped><tr><th>Оружие</th><th>Фраги</th><th>Игрок</th></tr>' +
        rows +
        '</table>',
    );
  }

  // 8. Почти рекорды — OPEN blocks (no details).
  for (const nm of model.nearMisses) {
    const player = renderPlayerName({
      name: nm.player.name,
      tag: nm.player.tag,
      isCommunity: true,
      agent: nm.player.agent ?? null,
    });
    parts.push(`${nm.emoji} <u>${esc(nm.header)}</u><br>${player} · ${esc(nm.value)}`);
  }

  // 9. Больше всех матчей — plain bold nick line (aggregate, no icons).
  if (model.mostActive) {
    parts.push(
      `🏆 <b>Больше всех матчей</b><br>${model.mostActive.nameHtml} · ${model.mostActive.count} за неделю`,
    );
  }

  // 10a. Top maps table.
  if (model.topMaps.length > 0) {
    const rows = model.topMaps
      .map(
        (m) =>
          `<tr><td>${m.emojiHtml ? `${m.emojiHtml} ` : ''}${esc(m.map)}</td>` +
          `<td align="right">${m.count}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🗺 Чаще всего играли на</h3>' +
        '<table><tr><th>Карта</th><th>Матчей</th></tr>' +
        rows +
        '</table>',
    );
  }

  // 10b. Top agents table.
  if (model.topAgents.length > 0) {
    const rows = model.topAgents
      .map(
        (a) =>
          `<tr><td>${a.emojiHtml ? `${a.emojiHtml} ` : ''}${esc(a.agent)}</td>` +
          `<td align="right">${a.count}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🎭 Чаще всего пикали</h3>' +
        '<table><tr><th>Агент</th><th>Пиков</th></tr>' +
        rows +
        '</table>',
    );
  }

  // 11. Footer.
  parts.push('<footer>#digest</footer>');

  // Join sections; the whole thing carries no raw '\n'.
  return parts.join('');
}
