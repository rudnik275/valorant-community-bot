/**
 * build.ts — Pure builder for the daily ace digest.
 *
 * Selects ace events from detected_events where:
 *   - event_type = 'ace'
 *   - status IN ('silent', 'digest-only')
 *   - detected_at in [windowStart, windowEnd)
 *   - id NOT IN excludeEventIds
 *
 * Renders a flat chronological list (one line per ace event = one (player, match)).
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
  text: string | null; // null when zero aces
  includedEventIds: number[]; // empty when zero aces
}

interface AceRow {
  id: number;
  puuid: string;
  matchId: string;
  detectedAt: number;
  payloadJson: string;
  riotName: string | null;
  riotTag: string | null;
  map: string | null;
  agent: string | null;
}

interface Line {
  eventId: number;
  riotName: string;
  riotTag: string;
  agent: string;
  map: string | null;
  matchId: string;
  rounds: number[]; // 0-indexed round ids
  roundsWon: number[] | null; // null = legacy event without the field
  detectedAt: number;
}

export async function buildDailyAceDigest(
  deps: BuildDailyDigestDeps,
): Promise<BuildDailyDigestResult> {
  const { db, windowStart, windowEnd, excludeEventIds } = deps;

  const conditions = [
    eq(detectedEvents.event_type, 'ace'),
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
      puuid: detectedEvents.riot_puuid,
      matchId: detectedEvents.match_id,
      detectedAt: detectedEvents.detected_at,
      payloadJson: detectedEvents.payload_json,
      riotName: users.riot_name,
      riotTag: users.riot_tag,
      map: matchRecords.map,
      agent: matchRecords.agent,
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

  const typedRows = rows as AceRow[];
  const includedEventIds: number[] = typedRows.map((r) => r.id);

  // One line per row (UNIQUE(match_id, event_type, riot_puuid) gives at most one row per (player, match)).
  const lines: Line[] = typedRows.map((row) => {
    let rounds: number[] = [];
    let roundsWon: number[] | null = null;
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      if (Array.isArray(payload['rounds'])) {
        rounds = (payload['rounds'] as unknown[]).filter((r): r is number => typeof r === 'number');
      }
      if (Array.isArray(payload['rounds_won'])) {
        roundsWon = (payload['rounds_won'] as unknown[]).filter((r): r is number => typeof r === 'number');
      }
    } catch {
      // ignore bad json
    }

    return {
      eventId: row.id,
      riotName: row.riotName ?? row.puuid,
      riotTag: row.riotTag ?? '',
      agent: row.agent ?? '',
      map: row.map,
      matchId: row.matchId,
      rounds: [...rounds].sort((a, b) => a - b),
      roundsWon,
      detectedAt: row.detectedAt,
    };
  });

  // Chronology — earliest first.
  lines.sort((a, b) => a.detectedAt - b.detectedAt);

  const header = `🎯 Daily Ace`;
  const legend = `<i>💀 ace без победы в раунде</i>\n<i>🏆 ace с победой в раунде</i>`;

  const lineTexts = lines.map((l) => renderLine(l));
  const text = `${header}\n${legend}\n\n${lineTexts.join('\n')}`;

  return { text, includedEventIds };
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
  const display = round0 + 1; // 1-indexed for chat (Valorant scoreboard convention)
  if (roundsWon === null) {
    // Legacy event without rounds_won field — no win/loss emoji available.
    return `round ${display}`;
  }
  const emoji = roundsWon.includes(round0) ? '🏆' : '💀';
  return `${emoji}round ${display}`;
}
