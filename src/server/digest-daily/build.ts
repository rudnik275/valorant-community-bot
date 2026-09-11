/** Select eligible daily events and render classic Telegram HTML, one row per occurrence. */
import { and, gte, lt, inArray, notInArray, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { readOccurrences } from '../digest/ace-knife.ts';
import { renderDailyDigest, type DailyEvent } from './render.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface BuildDailyDigestDeps {
  db: AnyDb;
  windowStart: number;
  windowEnd: number;
  excludeEventIds?: number[];
}

export interface BuildDailyDigestResult {
  text: string | null;
  includedEventIds: number[];
}

interface Row {
  id: number;
  eventType: 'ace' | 'knife_kill';
  puuid: string;
  matchId: string;
  payloadJson: string;
  riotName: string | null;
  riotTag: string | null;
  map: string | null;
  agent: string | null;
  rank: string | null;
}

export async function buildDailyAceDigest(deps: BuildDailyDigestDeps): Promise<BuildDailyDigestResult> {
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
      payloadJson: detectedEvents.payload_json,
      riotName: users.riot_name,
      riotTag: users.riot_tag,
      map: matchRecords.map,
      agent: matchRecords.agent,
      rank: matchRecords.rank_before,
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
    .orderBy(detectedEvents.detected_at, detectedEvents.id);

  const events: DailyEvent[] = (rows as Row[]).map((row) => ({
    ...row,
    name: row.riotName ?? row.puuid,
    tag: row.riotTag ?? '',
    count: readOccurrences(row.eventType, row.payloadJson),
  })).filter((event) => event.count > 0);

  return {
    text: events.length ? renderDailyDigest(events) : null,
    includedEventIds: events.map((event) => event.id),
  };
}
