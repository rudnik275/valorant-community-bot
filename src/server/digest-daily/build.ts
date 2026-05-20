/**
 * build.ts — Pure builder for the daily digest.
 *
 * Selects ace + knife_kill events from detected_events where:
 *   - event_type IN ('ace', 'knife_kill')
 *   - status IN ('silent', 'digest-only')
 *   - detected_at in [windowStart, windowEnd)
 *   - id NOT IN excludeEventIds
 *
 * Renders one combined Telegram HTML post (single chronological list,
 * one row per round; multi-round events fan out into multiple rows):
 *
 *   🍿 Эйсы и ножи за предыдущие 24 часа
 *
 *   <blockquote>
 *   💀 - без победы в раунде
 *   🏆 - с победой в раунде
 *   🎯 - Ace
 *   🔪 - Заколол баранчика
 *   🔪🦢 - Распотрошил гуся
 *   </blockquote>
 *
 *   🎯 22:00 <b>Name#TAG</b> · Agent · 🏆round 3 · 🗺<a href="…">Map</a>
 *
 *   🔪 22:21 <b>Name#TAG</b> · Agent · 💀round 13 · 🗺<a href="…">Map</a>
 *
 *   🔪🦢 22:42 <b>Name#TAG</b> · Agent · 🏆round 18 · 🗺<a href="…">Map</a>
 *
 * Returns null when no qualifying events exist.
 * Format and rationale: see ADR 0003.
 */

import { and, gte, lt, inArray, notInArray, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { esc } from '../publisher/templates.ts';
import { decodeKillEvents, decodeRounds } from '../lib/match-codec.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const MAP_EMOJI = '🗺';

const KYIV_TIME_FMT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatKyivHHMM(tsMs: number): string {
  return KYIV_TIME_FMT.format(new Date(tsMs));
}

export interface BuildDailyDigestDeps {
  db: AnyDb;
  windowStart: number; // ms epoch, inclusive
  windowEnd: number; // ms epoch, exclusive
  excludeEventIds?: number[]; // IDs already posted in prior daily runs
}

export interface BuildDailyDigestResult {
  text: string | null; // null when zero qualifying events
  includedEventIds: number[];
}

interface Row {
  id: number;
  eventType: 'ace' | 'knife_kill';
  puuid: string;
  matchId: string;
  detectedAt: number;
  payloadJson: string;
  riotName: string | null;
  riotTag: string | null;
  map: string | null;
  agent: string | null;
  roundsCompactJson: string | null;
  killEventsCompactJson: string | null;
}

interface Line {
  riotName: string;
  riotTag: string;
  agent: string;
  map: string | null;
  matchId: string;
  rounds: number[]; // 0-indexed, deduped, ascending
  roundsWon: number[] | null; // null = unknown; [] = all lost
  /** Parallel to `rounds`: `true` if any victim in that round was AFK. */
  roundsAfk: boolean[];
  detectedAt: number;
  eventType: 'ace' | 'knife_kill';
}

interface Entry {
  type: 'ace' | 'knife_kill';
  detectedAt: number;
  round0: number;
  won: boolean | null;
  /** For knife_kill: this kill's victim was Riot-flagged AFK that round. */
  afk: boolean;
  riotName: string;
  riotTag: string;
  agent: string;
  map: string | null;
  matchId: string;
}

/**
 * Derive the set of "won" round IDs for the player on the fly when the event
 * payload lacks `rounds_won` (legacy pre-ADR-0003 events). Returns null when
 * we can't determine.
 */
function deriveRoundsWon(
  rounds: number[],
  roundsCompactJson: string | null,
  killEventsCompactJson: string | null,
  riotPuuid: string,
): number[] | null {
  if (!roundsCompactJson || !killEventsCompactJson) return null;
  // decode* collapses null/malformed → []. The original code returned null on
  // a parse error; here a [] decode lands on the `!playerTeam` guard below and
  // also returns null, so the observable result is identical.
  const roundsCompact = decodeRounds(roundsCompactJson);
  const killEvents = decodeKillEvents(killEventsCompactJson);
  const playerTeam = killEvents.find((k) => k.attacker_puuid === riotPuuid)?.attacker_team;
  if (!playerTeam) return null;
  const winnerByRound = new Map<number, string>();
  for (const r of roundsCompact) {
    if (r.w) winnerByRound.set(r.r, r.w);
  }
  return rounds.filter((r) => winnerByRound.get(r) === playerTeam);
}

function rowToLine(row: Row): Line {
  let rounds: number[] = [];
  let roundsWonFromPayload: number[] | null = null;
  let victimsAfkRaw: boolean[] = [];
  try {
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    if (Array.isArray(payload['rounds'])) {
      rounds = (payload['rounds'] as unknown[]).filter((r): r is number => typeof r === 'number');
    }
    if (Array.isArray(payload['rounds_won'])) {
      roundsWonFromPayload = (payload['rounds_won'] as unknown[]).filter((r): r is number => typeof r === 'number');
    }
    if (Array.isArray(payload['victims_afk'])) {
      victimsAfkRaw = (payload['victims_afk'] as unknown[]).map((v) => v === true);
    }
  } catch {
    // ignore bad json
  }
  // Dedup rounds (knife events can repeat the same round when ≥2 knife kills landed in it).
  // For AFK: a deduped round is "AFK" if ANY of its raw victims was AFK (OR).
  const afkByRound = new Map<number, boolean>();
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i] as number;
    const wasAfk = victimsAfkRaw[i] === true;
    afkByRound.set(r, (afkByRound.get(r) ?? false) || wasAfk);
  }
  const sortedRounds = [...new Set(rounds)].sort((a, b) => a - b);
  const roundsAfk = sortedRounds.map((r) => afkByRound.get(r) ?? false);
  const roundsWon = roundsWonFromPayload ?? deriveRoundsWon(
    sortedRounds,
    row.roundsCompactJson,
    row.killEventsCompactJson,
    row.puuid,
  );

  return {
    riotName: row.riotName ?? row.puuid,
    riotTag: row.riotTag ?? '',
    agent: row.agent ?? '',
    map: row.map,
    matchId: row.matchId,
    rounds: sortedRounds,
    roundsWon,
    roundsAfk,
    detectedAt: row.detectedAt,
    eventType: row.eventType,
  };
}

function lineToEntries(line: Line): Entry[] {
  return line.rounds.map((round0, idx) => ({
    type: line.eventType,
    detectedAt: line.detectedAt,
    round0,
    won: line.roundsWon === null ? null : line.roundsWon.includes(round0),
    afk: line.roundsAfk[idx] === true,
    riotName: line.riotName,
    riotTag: line.riotTag,
    agent: line.agent,
    map: line.map,
    matchId: line.matchId,
  }));
}

export async function buildDailyAceDigest(
  deps: BuildDailyDigestDeps,
): Promise<BuildDailyDigestResult> {
  const { db, windowStart, windowEnd, excludeEventIds } = deps;

  const conditions = [
    inArray(detectedEvents.event_type, ['ace', 'knife_kill']),
    inArray(detectedEvents.status, ['silent', 'digest-only']),
    gte(detectedEvents.detected_at, windowStart),
    lt(detectedEvents.detected_at, windowEnd),
  ];

  if (excludeEventIds && excludeEventIds.length > 0) {
    conditions.push(notInArray(detectedEvents.id, excludeEventIds));
  }

  const rows = await db
    .select({
      id: detectedEvents.id,
      eventType: detectedEvents.event_type,
      puuid: detectedEvents.riot_puuid,
      matchId: detectedEvents.match_id,
      detectedAt: detectedEvents.detected_at,
      payloadJson: detectedEvents.payload_json,
      riotName: users.riot_name,
      riotTag: users.riot_tag,
      map: matchRecords.map,
      agent: matchRecords.agent,
      roundsCompactJson: matchRecords.rounds_compact,
      killEventsCompactJson: matchRecords.kill_events_compact,
    })
    .from(detectedEvents)
    .leftJoin(users, eq(users.riot_puuid, detectedEvents.riot_puuid))
    .leftJoin(
      matchRecords,
      and(
        eq(matchRecords.match_id, detectedEvents.match_id),
        eq(matchRecords.riot_puuid, detectedEvents.riot_puuid),
      ),
    )
    .where(and(...conditions))
    .orderBy(detectedEvents.detected_at);

  if (rows.length === 0) {
    return { text: null, includedEventIds: [] };
  }

  const typedRows = rows as Row[];
  const entries: Entry[] = [];
  for (const row of typedRows) {
    entries.push(...lineToEntries(rowToLine(row)));
  }

  if (entries.length === 0) {
    return { text: null, includedEventIds: [] };
  }

  entries.sort((a, b) => {
    if (a.detectedAt !== b.detectedAt) return a.detectedAt - b.detectedAt;
    if (a.round0 !== b.round0) return a.round0 - b.round0;
    if (a.type !== b.type) return a.type === 'ace' ? -1 : 1;
    return 0;
  });

  return {
    text: renderDailyDigestText(entries),
    includedEventIds: typedRows.map((r) => r.id),
  };
}

const HEADER = `🍿 Эйсы и ножи за предыдущие 24 часа`;
const LEGEND =
  `<blockquote>` +
  `💀 - без победы в раунде\n` +
  `🏆 - с победой в раунде\n` +
  `🎯 - Ace\n` +
  `🔪 - Заколол баранчика\n` +
  `🔪🦢 - Распотрошил гуся` +
  `</blockquote>`;

/** Pure renderer — emits the combined daily post. Exported for unit tests. */
export function renderDailyDigestText(entries: Entry[]): string {
  return `${HEADER}\n\n${LEGEND}\n\n${entries.map(renderEntry).join('\n\n')}`;
}

function renderEntry(e: Entry): string {
  const typeEmoji =
    e.type === 'ace'
      ? '🎯'
      : e.afk
        ? '🔪🦢'
        : '🔪';
  const time = formatKyivHHMM(e.detectedAt);
  const player = `<b>${esc(e.riotName)}#${esc(e.riotTag)}</b>`;
  const agentPart = e.agent ? ` · ${esc(e.agent)}` : '';
  const resultEmoji = e.won === null ? '' : e.won ? '🏆' : '💀';
  const roundPart = ` · ${resultEmoji}round ${e.round0 + 1}`;
  const mapPart = e.map
    ? ` · ${MAP_EMOJI}<a href="https://tracker.gg/valorant/match/${esc(e.matchId)}">${esc(e.map)}</a>`
    : '';

  return `${typeEmoji} ${time} ${player}${agentPart}${roundPart}${mapPart}`;
}
