/**
 * rich-templates.ts — Rich Message (Bot API 10.1+) renderers for the three
 * "trio" realtime events (#315): giant_slayer, match_comeback, community_clash.
 *
 * Each renders a SINGLE rich HTML message with the approved format:
 *
 *   [эмодзи] <b>Заголовок</b>
 *   <i>описание</i>
 *   <table>  Игрок | Агент · K/D   — ALL 10 participants, split into two teams
 *     [team-separator row, colspan=2 — team name, or blank between the fives]
 *     … 5 rows …
 *     [team-separator row]
 *     … 5 rows …
 *   </table>
 *   [map-emoji] <a href="…">Карта</a>
 *
 * The renderer returns `null` when the data is incomplete (no roster rows, or
 * any participant missing tier/kills/deaths — pre-#315 rows). `null` ⇒ the
 * publisher falls back to the legacy plain template for that event. This keeps
 * pending/old events rendering safely.
 *
 * Rich HTML dialect facts (see digest/rich-render.ts header, spike #306):
 *   - `<table>/<tr>/<th>/<td>` render as tables; `<tg-emoji>` survives inside
 *     cells; `<details><summary>` renders collapsible; raw `\n` collapses
 *     browser-style so block markup / `<br>` is used — no raw newlines here.
 *   - `colspan` on a `<td>` merges columns for the team-separator rows.
 */

import type { EventType } from './types.ts';
import { getFullRoster, type FullRosterRow, type SqliteDb } from '../db/queries.ts';
import { renderPlayerName } from './player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from './valorant-emoji.ts';

/** The three realtime events that render as full-roster rich messages (#315). */
const TRIO_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'giant_slayer',
  'match_comeback',
  'community_clash',
]);

/** True when `eventType` is one of the trio events that has a rich renderer. */
export function isTrioRichEvent(eventType: EventType): boolean {
  return TRIO_EVENT_TYPES.has(eventType);
}

/** HTML-escape (mirrors esc() in templates.ts / player-render.ts). */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tracker match URL for a match id. */
function trackerUrl(matchId: string): string {
  return `https://tracker.gg/valorant/match/${matchId}`;
}

/** Round scores per team_id (from the community_clash payload). */
export type TeamScores = Record<string, { won: number; lost: number }>;

export interface RichTemplateContext {
  /** All match participants (community + opponents). Empty ⇒ null render. */
  roster: FullRosterRow[];
  /** Match id for the tracker link. */
  matchId?: string;
  /** Map name for the link's map-emoji. */
  map?: string;
  /** community_clash only: id of the winning team (null ⇒ draw). */
  winnerTeamId?: string | null;
  /** community_clash only: per-team round scores for the "победа X:Y" line. */
  teamScores?: TeamScores;
  /**
   * giant_slayer only: puuids of the players the event fired for, oldest event
   * first. Used to render a prominent "who this is about" line under the title,
   * so the message names the giant-slayer(s) instead of leaving them anonymous
   * among the 10 roster rows.
   *
   * A LIST, not one puuid: several community members on the same team can each
   * beat a stronger enemy in one match, and the publisher folds their events
   * into a single message rather than posting the same title twice (owner,
   * 2026-08-09). Ignored for the other trio events (match_comeback = a whole
   * team; community_clash = no single subject).
   */
  heroPuuids?: string[];
  /**
   * match_comeback only: the deepest deficit the team dug itself out of and the
   * final score, so the description can say «отыгрались с 3:11 до 13:11»
   * instead of a scoreless "из глубокого отставания". The legacy plain template
   * always carried these numbers; the #315 rich rewrite dropped them and the
   * group noticed the message no longer says from WHAT score they came back
   * (owner, 2026-08-28). Absent ⇒ the generic sentence is used, so pre-#315
   * payloads still render.
   */
  comebackScores?: ComebackScores;
}

/** match_comeback deficit + final round scores, player side first. */
export interface ComebackScores {
  deficitPlayer: number;
  deficitOpponent: number;
  finalPlayer: number;
  finalOpponent: number;
}

/** Titles — emoji + verbatim heading text, bold per the approved format. */
const TITLES: Partial<Record<EventType, string>> = {
  giant_slayer: '💪 <b>Поводил(ла) по губам</b>',
  match_comeback: '👏 <b>Мы вами гордимся</b>',
  community_clash: '⚔️ <b>Френдлифаер</b>',
};

/**
 * One-line description under the title. Used to sit behind an «ℹ️ Что
 * случилось» `<details>` accordion; the owner dropped both the accordion and
 * the label (2026-08-04) — one short sentence is not worth a tap, and the
 * collapsed widget added a lot of vertical noise above the table.
 */
function describe(eventType: EventType, ctx: RichTemplateContext): string {
  switch (eventType) {
    case 'giant_slayer':
      return 'Выиграл(а) против превосходящего врага.';
    case 'match_comeback': {
      const s = ctx.comebackScores;
      if (!s) return 'Отыгрались из глубокого отставания и вырвали победу.';
      return `Отыгрались с ${s.deficitPlayer}:${s.deficitOpponent} до ${s.finalPlayer}:${s.finalOpponent} и вырвали победу.`;
    }
    case 'community_clash':
      return 'Наши сошлись друг против друга в одном матче.';
    default:
      return '';
  }
}

/** Second-column cell: `[agent-emoji] K/D`, e.g. "🦸 21/14". */
function agentKd(row: FullRosterRow): string {
  const emoji = agentToEmojiHtml(row.agent);
  const kd = `${row.kills}/${row.deaths}`;
  return emoji ? `${emoji} ${esc(kd)}` : esc(kd);
}

/**
 * giant_slayer "who this is about" line(s), rendered under the title so the
 * message names its subject(s) instead of leaving them anonymous among the 10
 * roster rows — one line per hero, in the given order. Returns '' when there
 * are no `heroPuuids` or none of them is in the roster (⇒ no line, message
 * still renders). Duplicate puuids collapse to one line.
 *
 * Unlike the table rows, the agent emoji IS kept here (there's no second
 * column to carry it) — mirroring the old plain giant_slayer template which
 * led with the player's tag + agent.
 */
function heroLines(ctx: RichTemplateContext): string {
  if (!ctx.heroPuuids || ctx.heroPuuids.length === 0) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const puuid of ctx.heroPuuids) {
    if (seen.has(puuid)) continue;
    seen.add(puuid);
    const hero = ctx.roster.find((r) => r.riot_puuid === puuid);
    if (!hero) continue;
    lines.push(renderPlayerName({
      name: hero.name ?? '',
      tag: hero.tag ?? '',
      isCommunity: hero.is_community,
      ...(hero.tier ? { rank: hero.tier } : {}),
      ...(hero.agent ? { agent: hero.agent } : {}),
    }));
  }
  return lines.map((l) => `<br>${l}`).join('');
}

/** One participant row: `<tr><td>renderPlayerName</td><td>[emoji] K/D</td></tr>`. */
function playerRow(row: FullRosterRow): string {
  const name = renderPlayerName({
    name: row.name ?? '',
    tag: row.tag ?? '',
    isCommunity: row.is_community,
    ...(row.tier ? { rank: row.tier } : {}),
    // Agent is shown in the SECOND column (not next to the name) per spec, so
    // it is intentionally omitted from renderPlayerName here.
  });
  return `<tr><td>${name}</td><td>${agentKd(row)}</td></tr>`;
}

/** A full-width separator row spanning both columns. */
function separatorRow(label: string): string {
  return `<tr><td colspan="2">${label}</td></tr>`;
}

/**
 * Every participant must have tier/kills/deaths for a complete table. Any null
 * ⇒ incomplete (pre-#315 roster) ⇒ caller falls back to legacy text.
 */
function rosterComplete(roster: FullRosterRow[]): boolean {
  if (roster.length === 0) return false;
  return roster.every(
    (r) => r.tier != null && r.kills != null && r.deaths != null,
  );
}

/** Group roster rows by team_id, preserving first-seen team order. */
function groupByTeam(roster: FullRosterRow[]): Array<{ teamId: string; rows: FullRosterRow[] }> {
  const order: string[] = [];
  const byTeam = new Map<string, FullRosterRow[]>();
  for (const r of roster) {
    if (!byTeam.has(r.team)) {
      byTeam.set(r.team, []);
      order.push(r.team);
    }
    byTeam.get(r.team)!.push(r);
  }
  return order.map((teamId) => ({ teamId, rows: byTeam.get(teamId)! }));
}

/**
 * Build the match link line under the table. Empty when no match id.
 *
 * NOT the shared `matchLink` helper: in a Rich Message an `<a>` whose content
 * includes a `<tg-emoji>` does not render as a tappable link — the map name
 * came out as plain black text (owner screenshot, 2026-08-04), while the very
 * same markup in a normal `sendMessage` links fine. So the rich path keeps the
 * map icon OUTSIDE the anchor and links the name alone, and puts the line on
 * its own row instead of butting it straight against `</table>`.
 */
function matchLinkLine(ctx: RichTemplateContext): string {
  if (!ctx.matchId) return '';
  const icon = ctx.map ? mapToEmojiHtml(ctx.map) : '';
  const label = ctx.map ? esc(ctx.map) : 'матч';
  const anchor = `<a href="${esc(trackerUrl(ctx.matchId))}">${label}</a>`;
  return `<br>${icon ? `${icon} ` : ''}${anchor}`;
}

/**
 * community_clash separator label for a team: «Команда А/Б», with a winner
 * mark + score on the winning team's separator, plain on the other.
 */
function clashTeamLabel(
  teamId: string,
  index: number,
  ctx: RichTemplateContext,
): string {
  const letter = index === 0 ? 'А' : index === 1 ? 'Б' : String(index + 1);
  const base = `Команда ${letter}`;
  if (ctx.winnerTeamId && teamId === ctx.winnerTeamId) {
    const score = ctx.teamScores?.[teamId];
    const scorePart = score ? ` — победа ${score.won}:${score.lost}` : ' — победа';
    return `🥇 <b>${base}${scorePart}</b>`;
  }
  return base;
}

/**
 * Pull the match_comeback deficit + final scores out of the event payload.
 * Returns `null` unless ALL FOUR are finite numbers — a half-filled score line
 * («отыгрались с 3:? до 13:11») is worse than the generic sentence, and old
 * pre-#315 payloads legitimately have none of them.
 */
function readComebackScores(payload: Record<string, unknown>): ComebackScores | null {
  const num = (key: string): number | null => {
    const v = payload[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const deficitPlayer = num('deficit_score_player');
  const deficitOpponent = num('deficit_score_opponent');
  const finalPlayer = num('final_score_player');
  const finalOpponent = num('final_score_opponent');
  if (
    deficitPlayer === null || deficitOpponent === null ||
    finalPlayer === null || finalOpponent === null
  ) return null;
  return { deficitPlayer, deficitOpponent, finalPlayer, finalOpponent };
}

/**
 * Render one of the three "trio" events as a rich HTML message, or `null` when
 * the roster data is incomplete (⇒ legacy plain-text fallback).
 */
export function renderRichTemplate(
  eventType: EventType,
  ctx: RichTemplateContext,
): string | null {
  const title = TITLES[eventType];
  if (!title) return null; // not a trio event
  if (!rosterComplete(ctx.roster)) return null;

  const teams = groupByTeam(ctx.roster);
  if (teams.length < 2) return null; // need both fives for the table

  // giant_slayer names its subject(s) on lines under the title (#315 lost the
  // "who" the old plain template had — the hero was just one of 10 table rows).
  // The other trio events have no single subject, so no hero line for them.
  const hero = eventType === 'giant_slayer' ? heroLines(ctx) : '';

  const desc = describe(eventType, ctx);
  const descLine = desc ? `<br><i>${esc(desc)}</i>` : '';

  // Build table body: team A rows, separator, team B rows, separator between.
  const bodyRows: string[] = [];
  teams.forEach((t, i) => {
    if (eventType === 'community_clash') {
      bodyRows.push(separatorRow(clashTeamLabel(t.teamId, i, ctx)));
    } else if (i > 0) {
      // giant_slayer / match_comeback: a BLANK full-width row between the two
      // fives — no team names, and no dash either (owner, 2026-08-04: the
      // «———» read as a stray artefact). First team needs no leading row.
      bodyRows.push(separatorRow(''));
    }
    for (const row of t.rows) bodyRows.push(playerRow(row));
  });

  const table =
    '<table><tr><th>Игрок</th><th>Агент · K/D</th></tr>' +
    bodyRows.join('') +
    '</table>';

  return `${title}${hero}${descLine}${table}${matchLinkLine(ctx)}`;
}

/**
 * Fetch the full match roster and assemble a rich HTML message for a trio event,
 * or `null` when it can't be rendered richly (not a trio event, no/incomplete
 * roster, missing both teams). `null` ⇒ publisher falls back to legacy text.
 *
 * Reads participant data from `match_rosters` at RENDER time (the durable
 * source of all 10 players + per-participant tier/K/D). `winner_team_id` and
 * `team_scores` for community_clash come from the event payload.
 */
export async function renderRichEvent(
  db: SqliteDb,
  eventType: EventType,
  payload: Record<string, unknown>,
  match: { match_id?: string; map?: string; heroPuuids?: string[] },
): Promise<string | null> {
  if (!isTrioRichEvent(eventType)) return null;
  if (!match.match_id) return null;

  const roster = await getFullRoster(db, match.match_id);

  const ctx: RichTemplateContext = {
    roster,
    ...(match.match_id ? { matchId: match.match_id } : {}),
    ...(match.map ? { map: match.map } : {}),
    ...(match.heroPuuids && match.heroPuuids.length > 0
      ? { heroPuuids: match.heroPuuids }
      : {}),
  };

  if (eventType === 'match_comeback') {
    const scores = readComebackScores(payload);
    if (scores) ctx.comebackScores = scores;
  }

  if (eventType === 'community_clash') {
    const winner = payload['winner_team_id'];
    ctx.winnerTeamId = typeof winner === 'string' ? winner : null;
    const scores = payload['team_scores'];
    if (scores && typeof scores === 'object') {
      ctx.teamScores = scores as TeamScores;
    }
  }

  return renderRichTemplate(eventType, ctx);
}
