/**
 * weekly-mvp-record.ts — Digest-tick detector for weekly MVP count record.
 *
 * Finds the player who took the most MVP-matches in the given week window.
 * Emits a 'record_mvp_count_week' event into detected_events ONLY when the
 * current week's leader strictly beats the all-time-best weekly MVP count.
 *
 * Call this once per digest tick, BEFORE buildDigest(), so the event is
 * present in detected_events when buildDigest queries for bright events.
 */

import { and, gte, lt, sql, eq, isNotNull } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { upsertWeeklyLeader, getAllTimeMaxWeeklyValue } from '../publisher/record-tracker.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const RECORD_TYPE = 'mvp_count_week';

/**
 * Query, upsert, and optionally emit a record event for weekly MVP count.
 *
 * @param db        Drizzle database instance
 * @param weekStartMs  Window start (inclusive, Unix ms)
 * @param weekEndMs    Window end (exclusive, Unix ms)
 * @param weekIso   ISO week string e.g. "2026-W19"
 */
export async function computeAndEmitWeeklyMvpRecord(
  db: AnyDb,
  weekStartMs: number,
  weekEndMs: number,
  weekIso: string,
): Promise<void> {
  // 1. Query MVP counts per puuid in window
  const rows = await db
    .select({
      riot_puuid: matchRecords.riot_puuid,
      mvp_count: sql<number>`SUM(${matchRecords.is_match_mvp})`,
    })
    .from(matchRecords)
    .where(
      and(
        isNotNull(matchRecords.riot_puuid),
        gte(matchRecords.started_at, weekStartMs),
        lt(matchRecords.started_at, weekEndMs),
      ),
    )
    .groupBy(matchRecords.riot_puuid)
    .orderBy(sql`SUM(${matchRecords.is_match_mvp}) DESC`)
    .limit(1);

  if (rows.length === 0) return;

  const leader = rows[0] as { riot_puuid: string; mvp_count: number };
  const mvpCount = Number(leader.mvp_count ?? 0);

  if (mvpCount < 1) return;

  // 2. Look up all-time max BEFORE upsert (to know if this week beats history)
  const prevMax = await getAllTimeMaxWeeklyValue(db, RECORD_TYPE);

  // 3. Upsert the weekly leader
  const { beatenForWeek } = await upsertWeeklyLeader(db, {
    recordType: RECORD_TYPE,
    weekIso,
    riotPuuid: leader.riot_puuid,
    value: mvpCount,
  });

  if (!beatenForWeek) return;

  // 4. Only emit event if this week strictly beats the all-time previous max
  const prevMaxValue = prevMax?.value ?? 0;
  if (mvpCount <= prevMaxValue) return;

  // 5. Look up previous record holder's name/tag if there was one
  let prevName: string | null = null;
  let prevTag: string | null = null;
  if (prevMax) {
    const [prevUser] = await db
      .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
      .from(users)
      .where(eq(users.riot_puuid, prevMax.puuid))
      .limit(1);
    if (prevUser) {
      prevName = prevUser.riot_name as string;
      prevTag = prevUser.riot_tag as string;
    }
  }

  // 6. Insert event with synthetic match_id for idempotency (unique index on match_id + event_type + puuid)
  const syntheticMatchId = `weekly:mvp:${weekIso}`;
  const payload = {
    value: mvpCount,
    prev_value: prevMaxValue,
    prev_puuid: prevMax?.puuid ?? null,
    prev_name: prevName,
    prev_tag: prevTag,
    week_iso: weekIso,
  };

  try {
    await db.insert(detectedEvents).values({
      event_type: 'record_mvp_count_week',
      riot_puuid: leader.riot_puuid,
      match_id: syntheticMatchId,
      payload_json: JSON.stringify(payload),
      detected_at: weekEndMs,
      status: 'digest-only',
    }).onConflictDoNothing();
  } catch {
    // Idempotent — unique constraint violation means event already inserted
  }
}
