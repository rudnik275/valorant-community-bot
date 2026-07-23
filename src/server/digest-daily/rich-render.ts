/**
 * rich-render.ts — Rich Message (Bot API 10.1+) renderer for the DAILY digest.
 *
 * The daily digest is built once (see build.ts) into a flat list of per-round
 * `RichDailyRow`s; `renderRichDailyDigest` turns that into the `html` string for
 * `sendRichMessage`. The legacy plain-text rendering (build.ts `renderDailyDigestText`)
 * is byte-for-byte unchanged — this module is a PARALLEL renderer over the same
 * per-round data.
 *
 * Layout (issue #315 «Дневной дайджест»):
 *   <h2>🍿 Эйсы и ножи за предыдущие 24 часа</h2>
 *   <details><summary>ℹ️ Легенда</summary>
 *     <blockquote>💀 - без победы в раунде<br>🏆 - с победой в раунде</blockquote>
 *   </details>
 *   <h3>🎯 Эйсы</h3>  <table striped> Игрок | Раунд | Матч            (if any)
 *   <h3>🔪 Ножи</h3>  <table striped> Игрок | Раунд | Матч            (if any)
 *
 * Row = ONE event occurrence (one round). Rows of the same player are adjacent
 * (grouped by player; within a player, chronological). No time column. A section
 * with zero events is omitted entirely; when BOTH are empty this renderer is not
 * called at all (build.ts returns richHtml=null alongside text=null).
 *
 * Rich HTML facts (verified in #306/#309): `<h2>/<h3>` render as headings,
 * `<table striped>` renders a striped table, `<details><summary>` collapses,
 * inline `<b>/<i>/<a>/<tg-emoji>` pass through, and **raw `\n` collapses
 * browser-style** — so the produced string carries NO raw `\n` (asserted in
 * tests).
 */

import { renderPlayerName, matchLinkIcon } from '../publisher/player-render.ts';

/** One per-round row for a daily-digest table (ace or knife). */
export interface RichDailyRow {
  eventType: 'ace' | 'knife_kill';
  /** Riot display name (unescaped) of the community player. */
  riotName: string;
  /** Riot tag (unescaped). */
  riotTag: string;
  /** Agent the player ran this match (for the right-side icon). '' ⇒ omitted. */
  agent: string;
  /** Player's rank in this match (Henrik tier name, e.g. "Diamond 3"). null ⇒ icon omitted. */
  rank: string | null;
  /** Map name of this match (for the link icon). null ⇒ fallback link label. */
  map: string | null;
  /** Match id — the tracker.gg URL is built from it. */
  matchId: string;
  /** 0-indexed round this occurrence happened in (rendered 1-based). */
  round0: number;
  /** Round outcome: true = won (🏆), false = lost (💀), null = unknown (no emoji). */
  won: boolean | null;
  /**
   * Stable ordering key inside the player's group — the event's `detected_at`,
   * then round. Rows are pre-sorted by build.ts; this field documents intent.
   */
  detectedAt: number;
}

function trackerUrl(matchId: string): string {
  return `https://tracker.gg/valorant/match/${matchId}`;
}

/**
 * Render the «Раунд» cell: `🏆 N` / `💀 N` (1-based), or bare `N` when the
 * outcome is unknown (legacy pre-ADR-0003 events without rounds_won and no
 * derivable match data). Mirrors the legacy round/win logic exactly.
 */
function renderRoundCell(round0: number, won: boolean | null): string {
  const n = round0 + 1;
  if (won === null) return `${n}`;
  return `${won ? '🏆' : '💀'} ${n}`;
}

/**
 * Group rows by player (first-appearance order), keeping each player's rows in
 * their existing (chronological) order, and emit the `<tr>` cells for one table.
 * "Same player" = same name#tag (the community player identity in this digest).
 */
function renderRows(rows: RichDailyRow[]): string {
  const order: string[] = [];
  const byPlayer = new Map<string, RichDailyRow[]>();
  for (const r of rows) {
    const key = `${r.riotName}#${r.riotTag}`;
    let bucket = byPlayer.get(key);
    if (!bucket) {
      bucket = [];
      byPlayer.set(key, bucket);
      order.push(key);
    }
    bucket.push(r);
  }

  const trs: string[] = [];
  for (const key of order) {
    for (const r of byPlayer.get(key)!) {
      const player = renderPlayerName({
        name: r.riotName,
        tag: r.riotTag,
        isCommunity: true,
        rank: r.rank,
        agent: r.agent || null,
      });
      const roundCell = renderRoundCell(r.round0, r.won);
      const matchCell = matchLinkIcon({ url: trackerUrl(r.matchId), mapName: r.map });
      trs.push(`<tr><td>${player}</td><td>${roundCell}</td><td>${matchCell}</td></tr>`);
    }
  }
  return trs.join('');
}

const HEADER = '<h2>🍿 Эйсы и ножи за предыдущие 24 часа</h2>';
const LEGEND =
  '<details><summary>ℹ️ Легенда</summary>' +
  '<blockquote>💀 - без победы в раунде<br>🏆 - с победой в раунде</blockquote>' +
  '</details>';

/**
 * Render the daily digest as Rich HTML for `sendRichMessage`.
 *
 * Каждая строка = одно событие (раунд); строки одного игрока идут подряд.
 * Секция без событий опускается целиком. The produced string contains NO raw
 * `\n`.
 */
export function renderRichDailyDigest(rows: RichDailyRow[]): string {
  const parts: string[] = [HEADER, LEGEND];

  const aces = rows.filter((r) => r.eventType === 'ace');
  if (aces.length > 0) {
    parts.push(
      '<h3>🎯 Эйсы</h3>' +
        '<table striped><tr><th>Игрок</th><th>Раунд</th><th>Матч</th></tr>' +
        renderRows(aces) +
        '</table>',
    );
  }

  const knives = rows.filter((r) => r.eventType === 'knife_kill');
  if (knives.length > 0) {
    parts.push(
      '<h3>🔪 Ножи</h3>' +
        '<table striped><tr><th>Игрок</th><th>Раунд</th><th>Матч</th></tr>' +
        renderRows(knives) +
        '</table>',
    );
  }

  return parts.join('');
}
