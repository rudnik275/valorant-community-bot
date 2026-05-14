/**
 * build.ts — Pure builder for the daily digest.
 *
 * Selects ace + knife_kill events from detected_events where:
 *   - event_type IN ('ace', 'knife_kill')
 *   - status IN ('silent', 'digest-only')
 *   - detected_at in [windowStart, windowEnd)
 *   - id NOT IN excludeEventIds
 *
 * Renders one combined Telegram HTML post:
 *
 *   🎯 Ace
 *   💀 без победы в раунде
 *   🏆 с победой в раунде
 *
 *   <ace lines>
 *
 *   🔪 Заколол баранчика
 *   <knife lines>
 *
 *   <i>Эйсы и ножи за предыдущие 24 часа</i>
 *
 * Sections are omitted when empty. Returns null when both are empty.
 * Format and rationale: see ADR 0003.
 */

import { and, gte, lt, inArray, notInArray, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { esc } from '../publisher/templates.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const MAP_EMOJI = '🗺';

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

export interface Line {
  eventId: number;
  riotName: string;
  riotTag: string;
  agent: string;
  map: string | null;
  matchId: string;
  rounds: number[]; // 0-indexed, deduped, ascending
  roundsWon: number[] | null; // null = unknown; [] = all lost
  detectedAt: number;
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
  let roundsCompact: Array<{ r: number; w?: string }> = [];
  try {
    roundsCompact = JSON.parse(roundsCompactJson);
  } catch {
    return null;
  }
  let killEvents: Array<{ attacker_puuid: string; attacker_team: string }> = [];
  try {
    killEvents = JSON.parse(killEventsCompactJson);
  } catch {
    return null;
  }
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
  try {
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    if (Array.isArray(payload['rounds'])) {
      rounds = (payload['rounds'] as unknown[]).filter((r): r is number => typeof r === 'number');
    }
    if (Array.isArray(payload['rounds_won'])) {
      roundsWonFromPayload = (payload['rounds_won'] as unknown[]).filter((r): r is number => typeof r === 'number');
    }
  } catch {
    // ignore bad json
  }
  // Dedup rounds (knife events can repeat the same round when ≥2 knife kills landed in it).
  const sortedRounds = [...new Set(rounds)].sort((a, b) => a - b);
  const roundsWon = roundsWonFromPayload ?? deriveRoundsWon(
    sortedRounds,
    row.roundsCompactJson,
    row.killEventsCompactJson,
    row.puuid,
  );

  return {
    eventId: row.id,
    riotName: row.riotName ?? row.puuid,
    riotTag: row.riotTag ?? '',
    agent: row.agent ?? '',
    map: row.map,
    matchId: row.matchId,
    rounds: sortedRounds,
    roundsWon,
    detectedAt: row.detectedAt,
  };
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
  const aceLines: Line[] = [];
  const knifeLines: Line[] = [];
  for (const row of typedRows) {
    const line = rowToLine(row);
    if (row.eventType === 'ace') aceLines.push(line);
    else knifeLines.push(line);
  }
  aceLines.sort((a, b) => a.detectedAt - b.detectedAt);
  knifeLines.sort((a, b) => a.detectedAt - b.detectedAt);

  return {
    text: renderDailyDigestText(aceLines, knifeLines),
    includedEventIds: typedRows.map((r) => r.id),
  };
}

/** Pure renderer — emits the combined daily post. Exported for unit tests. */
export function renderDailyDigestText(aceLines: Line[], knifeLines: Line[]): string {
  const header = `🎯 Ace`;
  const legend = `<i>💀 без победы в раунде</i>\n<i>🏆 с победой в раунде</i>`;
  const parts: string[] = [`${header}\n${legend}`];

  if (aceLines.length > 0) {
    parts.push(aceLines.map(renderLine).join('\n'));
  }
  if (knifeLines.length > 0) {
    parts.push(`🔪 Заколол баранчика\n${knifeLines.map(renderLine).join('\n')}`);
  }
  parts.push(`<i>Эйсы и ножи за предыдущие 24 часа</i>`);

  return parts.join('\n\n');
}

function renderLine(l: Line): string {
  const playerPart = `<b>${esc(l.riotName)}#${esc(l.riotTag)}</b>`;
  const agentPart = l.agent ? ` (${esc(l.agent)})` : '';
  const mapPart = l.map
    ? ` · ${MAP_EMOJI}<a href="https://tracker.gg/valorant/match/${esc(l.matchId)}">${esc(l.map)}</a>`
    : '';

  const aceCount = l.rounds.length;
  const roundsPart = aceCount === 0
    ? ''
    : aceCount === 1
      ? ` ${roundLabel(l.rounds[0]!, l.roundsWon)}`
      : ` x${aceCount} (${l.rounds.map((r) => roundLabel(r, l.roundsWon)).join(', ')})`;

  return `${playerPart}${agentPart}${roundsPart}${mapPart}`;
}

function roundLabel(round0: number, roundsWon: number[] | null): string {
  const display = round0 + 1;
  if (roundsWon === null) return `round ${display}`;
  const emoji = roundsWon.includes(round0) ? '🏆' : '💀';
  return `${emoji}round ${display}`;
}
