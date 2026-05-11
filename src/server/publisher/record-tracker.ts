import { eq, and } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { allTimeRecords } from '../db/schema/all_time_records.ts';

export interface UpsertRecordInput {
  recordType: string;
  weapon?: string;     // for kills_per_weapon; otherwise omit (defaults to '')
  value: number;
  riotPuuid: string;
  matchId: string;
  achievedAt?: number;  // ms; defaults to Date.now()
}

export interface UpsertRecordResult {
  beaten: boolean;
  prev: { value: number; puuid: string } | null;  // null if no previous record
}

/**
 * Upsert an all-time record. Returns { beaten: true, prev } when value > current.
 * Beats only on strict greater-than (no ties). Side effect: writes new row when beaten.
 */
export async function upsertRecord(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BunSQLiteDatabase | any,
  input: UpsertRecordInput,
): Promise<UpsertRecordResult> {
  const weapon = input.weapon ?? '';
  const achievedAt = input.achievedAt ?? Date.now();

  const [current] = await db
    .select()
    .from(allTimeRecords)
    .where(and(eq(allTimeRecords.record_type, input.recordType), eq(allTimeRecords.weapon, weapon)))
    .limit(1);

  if (current && input.value <= current.value) {
    return { beaten: false, prev: { value: current.value, puuid: current.riot_puuid } };
  }

  const prev = current ? { value: current.value, puuid: current.riot_puuid } : null;

  if (current) {
    await db
      .update(allTimeRecords)
      .set({
        riot_puuid: input.riotPuuid,
        value: input.value,
        match_id: input.matchId,
        achieved_at: achievedAt,
        prev_value: current.value,
        prev_puuid: current.riot_puuid,
      })
      .where(and(eq(allTimeRecords.record_type, input.recordType), eq(allTimeRecords.weapon, weapon)));
  } else {
    await db.insert(allTimeRecords).values({
      record_type: input.recordType,
      weapon,
      riot_puuid: input.riotPuuid,
      value: input.value,
      match_id: input.matchId,
      achieved_at: achievedAt,
      prev_value: null,
      prev_puuid: null,
    });
  }

  return { beaten: true, prev };
}
