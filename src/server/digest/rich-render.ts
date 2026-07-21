/**
 * rich-render.ts — Rich Message (Bot API 10.1+) renderer for the weekly digest.
 *
 * The weekly digest is built once (see build.ts) into a structured
 * `RichDigestModel`; `renderRichDigest` turns that model into the `html` string
 * for `sendRichMessage`. The legacy plain-text rendering is byte-for-byte
 * unchanged (build.ts still produces it verbatim) — this module is a PARALLEL
 * renderer over the same section data, so every section present in the legacy
 * text is present here.
 *
 * Rich HTML facts we rely on (verified against the live Bot API docs + spike
 * #306, PRs #307/#308):
 *   - `<h2>` / `<h3>` render as headings; `<table>`/`<tr>/<th>/<td>` render as
 *     tables (custom `<tg-emoji>` survives inside cells); `<details><summary>`
 *     renders collapsible.
 *   - Inline `<b>/<i>/<u>/<a>` and `<tg-emoji>` markup pass through untouched.
 *   - **Raw `\n` collapses browser-style** — every newline in a legacy block
 *     MUST become `<br>` (or block markup). Enforced here + asserted in tests
 *     (the produced html must contain no raw `\n`).
 *
 * Media (the promo cover image) is NOT embedded here — see PR #309 notes: the
 * Rich HTML dialect only accepts HTTP/HTTPS media URLs in the `html` field, and
 * embedding a locally-generated PNG buffer requires the `tg://photo?id=` +
 * `attach://` multipart path through grammY's untyped raw proxy, which is
 * fragile. The existing best-effort photo-reply flow is kept instead.
 */

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
   * `esc()`-escaped by build.ts — same value used in the legacy text). Rendered
   * verbatim into the cell; do NOT re-escape.
   */
  playerHtml: string;
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
  /**
   * Pre-rendered bright-event blocks (winstreak / records / rank-ups / …),
   * EXCLUDING the weapons-masters block, which is rendered as a table from
   * `weaponMasters`. Each string is legacy HTML (inline tags + `\n`); the
   * renderer converts `\n`→`<br>` and joins them.
   */
  brightBlocks: string[];
  /**
   * Structured weapons-masters rows for the «Мастера своего дела» table.
   * Empty ⇒ no weapons section this week. Already sorted desc by value
   * (matches the legacy ordering).
   */
  weaponMasters: RichWeaponMaster[];
  /** Pre-rendered near-miss blocks (legacy HTML). Empty ⇒ no «Почти рекорды». */
  nearMissBlocks: string[];
  /** Total matches this window (pulse line). */
  totalMatches: number;
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
 * Convert a legacy digest block (inline HTML with raw `\n`) into rich HTML:
 * every raw newline becomes `<br>` because the Rich HTML dialect collapses raw
 * newlines browser-style. Inline tags (`<b>/<i>/<u>/<a>/<tg-emoji>`) already in
 * the block pass through untouched.
 */
function blockToRich(block: string): string {
  return block.replaceAll('\n', '<br>');
}

/**
 * Render the weekly digest as Rich HTML for `sendRichMessage`.
 *
 * Layout (issue #309):
 *   <h2> title · date
 *   [bright blocks, <br>-joined]
 *   <h3>Мастера своего дела</h3> + <table>Оружие|Фраги|Игрок</table>  (if any)
 *   <details><summary>💨 Почти рекорды</summary>…</details>            (if any)
 *   <h3>Чаще всего играли на</h3> + <table>Карта|Матчей</table>        (if any)
 *   <h3>Чаще всего пикали</h3>    + <table>Агент|Пиков</table>         (if any)
 *   pulse line
 *   most-active line                                                    (if any)
 *   #digest
 *
 * The produced string contains NO raw `\n` (all newlines are `<br>` or block
 * markup) — the digest text otherwise collapses in the rich client.
 */
export function renderRichDigest(model: RichDigestModel): string {
  const parts: string[] = [];

  // Title.
  parts.push(`<h2>📅 Дайджест за неделю · ${esc(model.headerDate)}</h2>`);

  // Bright blocks (non-weapons): each legacy block, newlines → <br>, blocks
  // separated by a blank line (<br><br>) — mirrors the legacy '\n\n' join.
  if (model.brightBlocks.length > 0) {
    parts.push(model.brightBlocks.map(blockToRich).join('<br><br>'));
  }

  // «Мастера своего дела» — weapons table (custom emoji kept in cells).
  if (model.weaponMasters.length > 0) {
    const rows = model.weaponMasters
      .map(
        (w) =>
          `<tr><td>${w.weaponEmojiHtml} ${esc(w.weapon)}</td>` +
          `<td>${w.value}</td>` +
          `<td>${w.playerHtml}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🔫 Мастера своего дела</h3>' +
        '<i>лидеры по убийствам одним оружием за матч</i>' +
        '<table><tr><th>Оружие</th><th>Фраги</th><th>Игрок</th></tr>' +
        rows +
        '</table>',
    );
  }

  // Near-miss → collapsible «Почти рекорды».
  if (model.nearMissBlocks.length > 0) {
    const body = model.nearMissBlocks.map(blockToRich).join('<br><br>');
    parts.push(`<details><summary>💨 Почти рекорды</summary>${body}</details>`);
  }

  // Top maps table.
  if (model.topMaps.length > 0) {
    const rows = model.topMaps
      .map(
        (m) =>
          `<tr><td>${m.emojiHtml ? `${m.emojiHtml} ` : ''}${esc(m.map)}</td>` +
          `<td>${m.count}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🗺 Чаще всего играли на</h3>' +
        '<table><tr><th>Карта</th><th>Матчей</th></tr>' +
        rows +
        '</table>',
    );
  }

  // Top agents table.
  if (model.topAgents.length > 0) {
    const rows = model.topAgents
      .map(
        (a) =>
          `<tr><td>${a.emojiHtml ? `${a.emojiHtml} ` : ''}${esc(a.agent)}</td>` +
          `<td>${a.count}</td></tr>`,
      )
      .join('');
    parts.push(
      '<h3>🎭 Чаще всего пикали</h3>' +
        '<table><tr><th>Агент</th><th>Пиков</th></tr>' +
        rows +
        '</table>',
    );
  }

  // Pulse + most-active (plain lines, kept as content).
  const pulseLines: string[] = [];
  pulseLines.push(`📊 За неделю мы сыграли <b>${model.totalMatches}</b> матчей`);
  if (model.mostActive) {
    pulseLines.push(
      `🏆 Больше всех матчей<br>${model.mostActive.nameHtml} - ${model.mostActive.count} за неделю`,
    );
  }
  parts.push(pulseLines.join('<br><br>'));

  // Footer.
  parts.push('#digest');

  // Join sections with a blank line; the whole thing carries no raw '\n'.
  return parts.join('<br><br>');
}
