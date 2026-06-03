/**
 * purge-player.ts — Delete a player's rows from every table in FK-safe order.
 *
 * FK constraints (with foreign_keys=ON):
 *  - detected_events.riot_puuid → users.riot_puuid (nullable, no onDelete action — blocks delete)
 *  - all_time_records.riot_puuid → users.riot_puuid (notNull, no onDelete — blocks delete)
 *  - match_records.riot_puuid → users.riot_puuid (onDelete: 'set null') — explicit delete required
 *    to avoid orphaned NULLs before user row is gone.
 *  - weekly_records.riot_puuid — no FK.
 *  - users PK = telegram_id; riot_puuid is unique nullable.
 *
 * Required delete order:
 *   detected_events → all_time_records → weekly_records → match_records → users
 */

import { eq, sql } from 'drizzle-orm';
import { detectedEvents } from './schema/detected_events.ts';
import { allTimeRecords } from './schema/all_time_records.ts';
import { weeklyRecords } from './schema/weekly_records.ts';
import { matchRecords } from './schema/match_records.ts';
import { users } from './schema/users.ts';

export interface PurgePlayerInput {
  telegramId: number;
  riotPuuid: string | null;
}

export interface PurgePlayerCounts {
  detectedEvents: number;
  allTimeRecords: number;
  weeklyRecords: number;
  matchRecords: number;
  users: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function purgePlayer(db: any, input: PurgePlayerInput): Promise<PurgePlayerCounts> {
  const { telegramId, riotPuuid } = input;

  if (riotPuuid === null || riotPuuid === undefined) {
    // No puuid — skip all puuid-keyed deletes, just delete the users row
    const usersResult = await db
      .delete(users)
      .where(eq(users.telegram_id, telegramId));
    return {
      detectedEvents: 0,
      allTimeRecords: 0,
      weeklyRecords: 0,
      matchRecords: 0,
      users: usersResult.changes ?? usersResult.rowsAffected ?? 0,
    };
  }

  // 1. Delete detected_events (FK to users.riot_puuid, nullable, no onDelete — must go first)
  const deResult = await db
    .delete(detectedEvents)
    .where(eq(detectedEvents.riot_puuid, riotPuuid));
  const detectedEventsCount: number = deResult.changes ?? deResult.rowsAffected ?? 0;

  // 2. Delete all_time_records (FK to users.riot_puuid, notNull, no onDelete — must go before users)
  const atrResult = await db
    .delete(allTimeRecords)
    .where(eq(allTimeRecords.riot_puuid, riotPuuid));
  const allTimeRecordsCount: number = atrResult.changes ?? atrResult.rowsAffected ?? 0;

  // 3. Delete weekly_records (no FK — order doesn't matter but keep consistent)
  const wrResult = await db
    .delete(weeklyRecords)
    .where(eq(weeklyRecords.riot_puuid, riotPuuid));
  const weeklyRecordsCount: number = wrResult.changes ?? wrResult.rowsAffected ?? 0;

  // 4. Delete match_records (FK onDelete: 'set null' — explicit delete to avoid nulled orphans)
  const mrResult = await db
    .delete(matchRecords)
    .where(eq(matchRecords.riot_puuid, riotPuuid));
  const matchRecordsCount: number = mrResult.changes ?? mrResult.rowsAffected ?? 0;

  // 5. Delete users row (last — all referencing FKs are now gone)
  const usersResult = await db
    .delete(users)
    .where(eq(users.telegram_id, telegramId));
  const usersCount: number = usersResult.changes ?? usersResult.rowsAffected ?? 0;

  return {
    detectedEvents: detectedEventsCount,
    allTimeRecords: allTimeRecordsCount,
    weeklyRecords: weeklyRecordsCount,
    matchRecords: matchRecordsCount,
    users: usersCount,
  };
}

export interface SweepOrphanCounts {
  detectedEvents: number;
  allTimeRecords: number;
  weeklyRecords: number;
  matchRecords: number;
}

/**
 * Delete rows in the puuid-keyed tables whose riot_puuid is no longer present in
 * `users` — orphans left behind when a member row was removed WITHOUT going through
 * purgePlayer (e.g. the live chat-member listener's bare `DELETE FROM users`, which
 * intentionally leaves records untouched). This is the daily janitor that guarantees
 * records only ever reflect current members, regardless of how a user was removed.
 *
 * Deletes match_records too, so a subsequent records rebuild cannot resurrect a
 * departed player from their surviving match history.
 *
 * IMPORTANT: the caller MUST guard against an empty `users` table before calling this.
 * With no linked members the "not in users" set matches every row and would wipe all
 * records — see runReconcileMembershipTick's allMembers guard. Rows with a NULL
 * riot_puuid are never matched (NULL NOT IN (...) is NULL), so they are left alone.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepOrphanedRecords(db: any): Promise<SweepOrphanCounts> {
  const orphaned = sql`riot_puuid NOT IN (SELECT riot_puuid FROM users WHERE riot_puuid IS NOT NULL)`;

  const de = await db.delete(detectedEvents).where(orphaned);
  const atr = await db.delete(allTimeRecords).where(orphaned);
  const wr = await db.delete(weeklyRecords).where(orphaned);
  const mr = await db.delete(matchRecords).where(orphaned);

  return {
    detectedEvents: de.changes ?? de.rowsAffected ?? 0,
    allTimeRecords: atr.changes ?? atr.rowsAffected ?? 0,
    weeklyRecords: wr.changes ?? wr.rowsAffected ?? 0,
    matchRecords: mr.changes ?? mr.rowsAffected ?? 0,
  };
}
