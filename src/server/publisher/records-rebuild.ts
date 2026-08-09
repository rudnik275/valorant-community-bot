/**
 * records-rebuild.ts — Clear derived records tables and rebuild them from surviving match_records.
 *
 * Extracted from scripts/launch/backfill-records.ts.
 * All functions take an injected `db` parameter — no module-level singleton.
 *
 * clearDerivedRecords(db): DELETE FROM all_time_records + weekly_records.
 * rebuildAllRecords(db, nowMs?): clearDerivedRecords then run all backfill steps.
 *   `nowMs` decides which digest window is still open — see
 *   backfillWeeklyMvpRecords. Defaults to Date.now(); injected by tests.
 *
 * Idempotent. After a clean rebuild, prev_value/prev_puuid reset to null — acceptable.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

import { asc, desc, isNotNull, and } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { allTimeRecords } from '../db/schema/all_time_records.ts';
import { weeklyRecords } from '../db/schema/weekly_records.ts';
import { upsertWeeklyLeader, upsertRecord } from './record-tracker.ts';
import { computeWeekIso, digestWeekEndFor } from '../lib/kyiv-week.ts';

// --------------------------------------------------------------------------
// Helpers (copied from backfill-records.ts)
// --------------------------------------------------------------------------

// Weapons to exclude from kills_per_weapon backfill
export const BACKFILL_EXCLUDED = new Set([
  'Vandal', 'Phantom', 'Knife', 'Fall',
  '9c82e19d-4575-0200-1a81-3eacf00cf872', // Vandal
  'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', // Phantom
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7', // Knife
]);

export const BACKFILL_WEAPON_NAME: Record<string, string> = {
  '4ade7faa-4cf1-8376-95ef-39884480959b': 'Operator',
  '910be174-449b-a89f-1c5d-ffa1a8c3d6c2': 'Marshal',
  '29a0cfab-485b-f5d5-779a-b59f85e204a8': 'Classic',
  '42da8ccc-40d5-affc-beec-15522c2d502d': 'Shorty',
  '44d4e95c-4157-0037-81b2-17841bf2e8e9': 'Frenzy',
  'a03b24d3-4319-996d-0f8c-94bbfba1dfc7': 'Ghost',
  '1baa85b4-4c70-1284-64bb-8481d58f4d8d': 'Sheriff',
  'f7e1b454-50c7-a545-a891-f5c154926dda': 'Stinger',
  '462080d1-4035-2937-7c09-27aa2a5c27a7': 'Spectre',
  'ec845bf4-4f79-ddda-a3da-0db3d5fb9896': 'Bucky',
  '63e6c2b6-4a8e-869c-3d4c-e38355226584': 'Ares',
  '55d8a0f4-4274-ca67-fe2c-06ab45efdf58': 'Odin',
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7': 'Knife',
};

export function backfillCanonicalWeapon(raw: string): string {
  return BACKFILL_WEAPON_NAME[raw] ?? raw;
}

export interface KillEventCompact {
  round: number;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
  attacker_team: string;
  victim_team: string;
}

/**
 * Tie-break appended to every winner pick below: earliest achievement first.
 *
 * The live detectors take a record only on a strict `>` (see `upsertRecord`), so
 * the FIRST player to reach a value keeps it until somebody genuinely beats it.
 * A rebuild replays that same stream and has to land on the same person.
 * Without a secondary key SQLite handed a tied record to whichever row the scan
 * happened to emit, so two rebuilds of identical data crowned different people
 * and an unrelated purge silently moved a record nobody had beaten (owner,
 * 2026-08-09).
 *
 * `riot_puuid` separates two players inside the same match (identical
 * `started_at`) and matches the tie-break the digest boards use; `match_id`
 * completes the `match_records` primary key, so the ordering is total and can
 * never fall back on scan order.
 */
const EARLIEST_ACHIEVEMENT_FIRST = [
  matchRecords.started_at,
  matchRecords.riot_puuid,
  matchRecords.match_id,
];

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Delete all rows from all_time_records and weekly_records.
 * Call this before rebuilding to avoid stale entries from departed players.
 */
export async function clearDerivedRecords(db: AnyDb): Promise<void> {
  await db.delete(allTimeRecords);
  await db.delete(weeklyRecords);
}

async function backfillKillsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid))
    .orderBy(desc(matchRecords.kills), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.kills <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'kills_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.kills,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillDamageDealtMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.damage_dealt)))
    .orderBy(desc(matchRecords.damage_dealt), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.damage_dealt == null || top.damage_dealt <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'damage_dealt_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.damage_dealt,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillDamageReceivedMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.damage_received)))
    .orderBy(desc(matchRecords.damage_received), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.damage_received == null || top.damage_received <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'damage_received_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.damage_received,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillDeathsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid))
    .orderBy(desc(matchRecords.deaths), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.deaths <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'deaths_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.deaths,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillHeadshotsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.headshots)))
    .orderBy(desc(matchRecords.headshots), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.headshots == null || top.headshots <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'headshots_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.headshots,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillLegshotsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.legshots)))
    .orderBy(desc(matchRecords.legshots), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.legshots == null || top.legshots <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'legshots_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.legshots,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

/**
 * 🐴 Троянский конь. Wiped by `clearDerivedRecords` like every other type, but
 * never restored — so after any purge the record restarted from zero and the
 * group got a fresh «новый рекорд» on 1, then 3, then 4, then 9 первых смертей
 * over the following week (owner, 2026-08-09).
 */
async function backfillDiedFirstRoundsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.died_first_rounds)))
    .orderBy(desc(matchRecords.died_first_rounds), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.died_first_rounds == null || top.died_first_rounds <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'died_first_rounds_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.died_first_rounds,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

/** ⚓ Якорь — the mirror of died_first_rounds, and wiped by the same rebuild. */
async function backfillSurvivedLastRoundsMatch(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.survived_last_rounds)))
    .orderBy(desc(matchRecords.survived_last_rounds), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.survived_last_rounds == null || top.survived_last_rounds <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'survived_last_rounds_match',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.survived_last_rounds,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillLongestMatchMinutes(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.game_length_ms)))
    .orderBy(desc(matchRecords.game_length_ms), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.game_length_ms == null || top.game_length_ms <= 0) return;
  const minutes = Math.round(top.game_length_ms / 60000);
  if (minutes <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'longest_match_minutes',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: minutes,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillLongestMatchRounds(db: AnyDb): Promise<void> {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid))
    .orderBy(desc(matchRecords.rounds_played), ...EARLIEST_ACHIEVEMENT_FIRST)
    .limit(1);
  if (rows.length === 0) return;
  const top = rows[0]!;
  if (top.rounds_played == null || top.rounds_played <= 0) return;
  await db.insert(allTimeRecords).values({
    record_type: 'longest_match_rounds',
    weapon: '',
    riot_puuid: top.riot_puuid!,
    value: top.rounds_played,
    match_id: top.match_id,
    achieved_at: top.started_at,
    prev_value: null,
    prev_puuid: null,
  }).onConflictDoNothing();
}

async function backfillWeeklyMvpRecords(db: AnyDb, nowMs: number): Promise<void> {
  const allRows = await db
    .select({
      riot_puuid: matchRecords.riot_puuid,
      started_at: matchRecords.started_at,
      is_match_mvp: matchRecords.is_match_mvp,
    })
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid))
    // Oldest first, so the Fri→Fri window below advances with a single cursor
    // instead of re-deriving the Kyiv wall clock for every one of the group's
    // thousands of rows.
    .orderBy(asc(matchRecords.started_at));

  if (allRows.length === 0) return;

  // The window the digest has NOT closed yet — the Friday tick owns it. It is
  // the tick that writes `weekly_records` for the running week, and
  // `upsertWeeklyLeader` only ever raises, so a rebuild that pre-fills that row
  // from a partial week leaves the tick unable to beat its own bar: it returns
  // at `!beatenForWeek` and «👑 Король MVP за неделю» is dropped for that week
  // without a trace. This rebuild fires from the 06:30 reconcile whenever a
  // member actually leaves, so any midweek departure could silence Friday's
  // crown (owner, 2026-08-09).
  const openWeekEnd = digestWeekEndFor(nowMs);

  const weekMap = new Map<string, Map<string, number>>();
  // A match counts towards the digest window it was PLAYED IN — Fri 19:00 Kyiv
  // → Fri 19:00 Kyiv — not towards its ISO Mon–Sun calendar week. Bucketing by
  // `computeWeekIso(started_at)` moved every Friday-evening and weekend match
  // into the neighbouring row, so the rebuild and the tick summed different
  // matches under the same key: past weeks were rewritten with counts no digest
  // ever announced, and `getAllTimeMaxWeeklyValue` — the bar every future crown
  // has to clear — was raised to values no Fri→Fri window ever produced.
  let windowEnd = -Infinity;
  let windowIso = '';
  for (const row of allRows) {
    if (row.started_at >= windowEnd) {
      windowEnd = digestWeekEndFor(row.started_at);
      windowIso = computeWeekIso(windowEnd);
    }
    // Sorted ascending: once a row lands in the open window, so does every row
    // after it.
    if (windowEnd >= openWeekEnd) break;
    if (!weekMap.has(windowIso)) weekMap.set(windowIso, new Map());
    const puuidMap = weekMap.get(windowIso)!;
    const prev = puuidMap.get(row.riot_puuid!) ?? 0;
    puuidMap.set(row.riot_puuid!, prev + (row.is_match_mvp ?? 0));
  }

  for (const [weekIso, puuidMap] of weekMap.entries()) {
    // Most MVPs, ties to the smallest puuid — the exact rule the live weekly
    // tick uses (`ORDER BY SUM(is_match_mvp) DESC, riot_puuid` in
    // weekly-mvp-record.ts), so a rebuild can never crown a different king than
    // the tick did. The old `count > leaderCount` scan kept whichever tied
    // player the Map happened to hold first, and that order came straight from
    // an unordered SELECT — two rebuilds of the same data disagreed about the
    // same past week. Bare `<` rather than localeCompare, to compare bytes the
    // way SQLite's BINARY collation does.
    const [leader] = [...puuidMap.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    if (!leader) continue;
    const [leaderPuuid, leaderCount] = leader;
    if (leaderCount < 1) continue;

    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso,
      riotPuuid: leaderPuuid,
      value: leaderCount,
    });
  }
}

async function backfillKillsPerWeapon(db: AnyDb): Promise<void> {
  const rows = await db
    .select({
      riot_puuid: matchRecords.riot_puuid,
      match_id: matchRecords.match_id,
      started_at: matchRecords.started_at,
      kill_events_compact: matchRecords.kill_events_compact,
    })
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid))
    // upsertRecord replaces only on a strict `>`, so the first row through here
    // with the top count keeps the weapon. Replay the matches oldest-first,
    // exactly as the live stream saw them — an unordered scan gave a tied
    // weapon record to whichever row SQLite listed first.
    .orderBy(...EARLIEST_ACHIEVEMENT_FIRST);

  if (rows.length === 0) return;

  for (const row of rows) {
    const puuid = row.riot_puuid!;
    let kills: KillEventCompact[];
    try {
      kills = JSON.parse(row.kill_events_compact as string) as KillEventCompact[];
    } catch {
      continue;
    }
    if (!Array.isArray(kills) || kills.length === 0) continue;

    const byWeapon = new Map<string, number>();
    for (const k of kills) {
      if (k.attacker_puuid !== puuid) continue;
      if (BACKFILL_EXCLUDED.has(k.weapon)) continue;
      const w = backfillCanonicalWeapon(k.weapon);
      byWeapon.set(w, (byWeapon.get(w) ?? 0) + 1);
    }

    for (const [weapon, count] of byWeapon) {
      await upsertRecord(db, {
        recordType: 'kills_per_weapon',
        weapon,
        value: count,
        riotPuuid: puuid,
        matchId: row.match_id,
        achievedAt: row.started_at,
      });
    }
  }
}

/**
 * Clear derived records and rebuild all record types from surviving match_records.
 * This re-attributes records to the best remaining member after a purge.
 */
export async function rebuildAllRecords(db: AnyDb, nowMs: number = Date.now()): Promise<void> {
  await clearDerivedRecords(db);
  await backfillKillsMatch(db);
  await backfillDamageDealtMatch(db);
  await backfillDamageReceivedMatch(db);
  await backfillDeathsMatch(db);
  await backfillHeadshotsMatch(db);
  await backfillLegshotsMatch(db);
  await backfillDiedFirstRoundsMatch(db);
  await backfillSurvivedLastRoundsMatch(db);
  await backfillLongestMatchMinutes(db);
  await backfillLongestMatchRounds(db);
  await backfillWeeklyMvpRecords(db, nowMs);
  await backfillKillsPerWeapon(db);
}
