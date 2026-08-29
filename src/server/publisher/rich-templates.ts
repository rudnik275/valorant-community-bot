/**
 * rich-templates.ts — Rich Message (Bot API 10.1+) renderers for the three
 * "trio" realtime events (#315): giant_slayer, match_comeback, community_clash.
 *
 * Each renders a SINGLE rich HTML message with the approved format:
 *
 *   [эмодзи] <b>Заголовок</b>
 *   <i>описание — for community_clash this also carries the outcome + score</i>
 *   [<b>Команда А</b> — plain text, community_clash only]
 *   <table>  Игрок | Агент · K/D  ·  5 rows
 *   [<b>Команда Б</b>]
 *   <table>  Игрок | Агент · K/D  ·  5 rows
 *   [map-emoji] <a href="…">Карта</a>
 *
 * ONE TABLE PER TEAM, each with its own header (owner, 2026-08-29). It used to
 * be a single table whose fives were divided by a full-width `colspan=2` row —
 * carrying the team name for community_clash, blank for the other two. Two
 * tables read better and let the team name be ordinary text above its table
 * instead of a row inside it.
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
 */

import type { EventType } from './types.ts';
import { getFullRoster, type FullRosterRow, type SqliteDb } from '../db/queries.ts';
import { renderPlayerName } from './player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from './valorant-emoji.ts';

/**
 * Compact-table attribute for the roster table (#352).
 *
 * `is_compact` is documented on the STRUCTURED `RichBlockTable` /
 * `InputRichBlockTable` (Bot API 10.3), and this renderer emits HTML, so the
 * HTML dialect's spelling of it is not something the reference states. Probed
 * live on 2026-08-29: `sendRichMessage` accepts `<table compact>` and delivers
 * the message normally, i.e. the attribute is at worst inert — it cannot break
 * a trio-event post or push it onto the legacy plain-text fallback.
 *
 * Whether it actually tightens the rendering is a visual question left to the
 * owner (plain vs compact samples sent to their DM). If the two look identical,
 * delete this constant and its interpolation — nothing else depends on it.
 *
 * Deliberately NOT applied anywhere else: the digest moved off tables in #345 /
 * #346 and stays on flat lines. This is the only table left in production.
 */
const COMPACT_ATTR = ' compact';

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

/** The letter a team is shown under, by its position in the table. */
function teamLetter(index: number): string {
  return index === 0 ? 'А' : index === 1 ? 'Б' : String(index + 1);
}

/**
 * community_clash outcome sentence — how the match ended and with what score —
 * placed in the description under the title.
 *
 * The result used to live only on the winning team's separator row, halfway
 * down a ten-row table: you had to scroll past five players to find out who
 * won (owner, 2026-08-29). The whole outcome goes above the table now and the
 * table below it stays plain — same treatment match_comeback got in #348.
 *
 * Three endings, all stated here:
 *   - one side won      → «Команда Б выиграла 13:7.»
 *   - the match tied    → «Ничья 12:12.»
 *   - nothing is known  → '' (the message still renders, it just claims nothing)
 *
 * A draw and a missing result look identical in `winnerTeamId` — both are null,
 * since the detector leaves it null for `result === 'draw'` AND when it cannot
 * work out the player's team. `teamScores` is what separates them: present ⇒ we
 * really did see a tied match; absent ⇒ we know nothing and must say nothing.
 * Old pre-#315 payloads carry neither and fall into the silent case.
 */
function clashOutcome(
  teams: Array<{ teamId: string; rows: FullRosterRow[] }>,
  ctx: RichTemplateContext,
): string {
  if (ctx.winnerTeamId) {
    const index = teams.findIndex((t) => t.teamId === ctx.winnerTeamId);
    // A winner we can't place in the table can't be named — stay silent rather
    // than guess a letter.
    if (index < 0) return '';

    const letter = teamLetter(index);
    const score = ctx.teamScores?.[ctx.winnerTeamId];
    return score
      ? `Команда ${letter} выиграла ${score.won}:${score.lost}.`
      : `Победила команда ${letter}.`;
  }

  const firstTeam = teams[0];
  const score = firstTeam ? ctx.teamScores?.[firstTeam.teamId] : undefined;
  // Either side's numbers describe a draw equally well — they are equal.
  return score ? `Ничья ${score.won}:${score.lost}.` : '';
}

/**
 * community_clash separator label: just «Команда А/Б».
 *
 * Deliberately carries no medal and no score. Both used to sit here, which is
 * how the result ended up buried mid-table; the outcome now lives in one place
 * above the table (see `clashOutcome`) and this row only says which five is
 * which.
 */
function clashTeamLabel(index: number): string {
  return `Команда ${teamLetter(index)}`;
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

  // The clash outcome needs the team ORDER (to say «Команда Б»), which only
  // exists once the roster is grouped — so it is appended here rather than
  // built inside `describe`, which sees the context but not the grouping.
  const outcome = eventType === 'community_clash' ? clashOutcome(teams, ctx) : '';
  const desc = [describe(eventType, ctx), outcome].filter(Boolean).join(' ');
  const descLine = desc ? `<br><i>${esc(desc)}</i>` : '';

  // One table PER TEAM, each with its own header, rather than a single table
  // split by full-width separator rows (owner, 2026-08-29 — reads better).
  //
  // community_clash puts the team name above its table as ordinary text, not
  // as a row inside it. The other two events never named their teams, and this
  // is not the place to start: they simply get two tables where they used to
  // have one blank separator row doing the same job.
  const teamBlocks = teams.map((t, i) => {
    // The FIRST caption follows the description — an inline line — so a single
    // <br> only drops it onto the next row and it reads as glued to the result
    // (owner, 2026-08-29). Later captions follow a `</table>`, a block element
    // that already brings its own vertical gap. Hence the asymmetry.
    const lead = i === 0 ? '<br><br>' : '<br>';
    const label = eventType === 'community_clash'
      ? `${lead}<b>${esc(clashTeamLabel(i))}</b>`
      : '';
    const rows = t.rows.map(playerRow).join('');
    return `${label}<table${COMPACT_ATTR}><tr><th>Игрок</th><th>Агент · K/D</th></tr>${rows}</table>`;
  });

  return `${title}${hero}${descLine}${teamBlocks.join('')}${matchLinkLine(ctx)}`;
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
