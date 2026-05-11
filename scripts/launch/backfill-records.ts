// One-off: seed all_time_records and weekly_records from existing match_records history.
// Run AFTER db:migrate, BEFORE enabling record detectors in production.
// Idempotent — running twice does not corrupt.
//
// Usage:
//   ./scripts/with-secrets.sh bun run scripts/launch/backfill-records.ts

import { db } from '../../src/server/db/client.ts';
import { matchRecords } from '../../src/server/db/schema/match_records.ts';
import { allTimeRecords } from '../../src/server/db/schema/all_time_records.ts';
import { desc, isNotNull, and, gte, lt, sql } from 'drizzle-orm';
import { upsertWeeklyLeader, upsertRecord } from '../../src/server/publisher/record-tracker.ts';

async function backfillKillsMatch() {
  const rows = await db.select().from(matchRecords).where(isNotNull(matchRecords.riot_puuid)).orderBy(desc(matchRecords.kills)).limit(1);
  if (rows.length === 0) {
    console.log('kills_match: no match records yet, skipping');
    return;
  }
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
  console.log(`kills_match: seeded ${top.kills} by ${top.riot_puuid}`);
}

async function backfillDamageDealtMatch() {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(isNotNull(matchRecords.damage_dealt))
    .orderBy(desc(matchRecords.damage_dealt))
    .limit(1);
  if (rows.length === 0) {
    console.log('damage_dealt_match: no match records with damage_dealt yet, skipping');
    return;
  }
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
  console.log(`damage_dealt_match: seeded ${top.damage_dealt} by ${top.riot_puuid}`);
}

async function backfillDamageReceivedMatch() {
  const rows = await db
    .select()
    .from(matchRecords)
    .where(isNotNull(matchRecords.damage_received))
    .orderBy(desc(matchRecords.damage_received))
    .limit(1);
  if (rows.length === 0) {
    console.log('damage_received_match: no match records with damage_received yet, skipping');
    return;
  }
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
  console.log(`damage_received_match: seeded ${top.damage_received} by ${top.riot_puuid}`);
}

async function backfillDeathsMatch() {
  const rows = await db.select().from(matchRecords).where(isNotNull(matchRecords.riot_puuid)).orderBy(desc(matchRecords.deaths)).limit(1);
  if (rows.length === 0) {
    console.log('deaths_match: no match records yet, skipping');
    return;
  }
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
  console.log(`deaths_match: seeded ${top.deaths} by ${top.riot_puuid}`);
}

async function backfillHeadshotsMatch() {
  const rows = await db.select().from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.headshots)))
    .orderBy(desc(matchRecords.headshots))
    .limit(1);
  if (rows.length === 0) {
    console.log('headshots_match: no match records with headshots data yet, skipping');
    return;
  }
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
  console.log(`headshots_match: seeded ${top.headshots} by ${top.riot_puuid}`);
}

async function backfillLegshotsMatch() {
  const rows = await db.select().from(matchRecords)
    .where(and(isNotNull(matchRecords.riot_puuid), isNotNull(matchRecords.legshots)))
    .orderBy(desc(matchRecords.legshots))
    .limit(1);
  if (rows.length === 0) {
    console.log('legshots_match: no match records with legshots data yet, skipping');
    return;
  }
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
  console.log(`legshots_match: seeded ${top.legshots} by ${top.riot_puuid}`);
}

/**
 * Compute ISO week string for a given timestamp (Kyiv timezone, Thursday-anchor).
 */
function computeWeekIso(ms: number): string {
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmtDate.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', weekday: 'short' });
  const weekdayStr = fmtWeekday.format(ms);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[weekdayStr] ?? 0;

  const todayMidnightMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayMs = todayMidnightMs - daysFromMonday * 86400000;

  const thursdayMs = mondayMs + 3 * 86400000;
  const thursdayDate = new Date(thursdayMs);
  const thurYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(thurYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay();
  const jan4Monday = jan4 - (jan4Weekday === 0 ? 6 : jan4Weekday - 1) * 86400000;
  const weekNumber = Math.floor((thursdayMs - jan4Monday) / (7 * 86400000)) + 1;
  return `${thurYear}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Seed weekly_records table with per-week MVP leaders from historical match_records.
 * Does NOT emit detected_events. Idempotent.
 */
async function backfillWeeklyMvpRecords() {
  // Get all distinct ISO weeks present in match_records
  const allRows = await db
    .select({ riot_puuid: matchRecords.riot_puuid, started_at: matchRecords.started_at, is_match_mvp: matchRecords.is_match_mvp })
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid));

  if (allRows.length === 0) {
    console.log('weekly mvp: no match records, skipping');
    return;
  }

  // Group by ISO week
  const weekMap = new Map<string, Map<string, number>>();
  for (const row of allRows) {
    const weekIso = computeWeekIso(row.started_at);
    if (!weekMap.has(weekIso)) weekMap.set(weekIso, new Map());
    const puuidMap = weekMap.get(weekIso)!;
    const prev = puuidMap.get(row.riot_puuid!) ?? 0;
    puuidMap.set(row.riot_puuid!, prev + (row.is_match_mvp ?? 0));
  }

  let seeded = 0;
  for (const [weekIso, puuidMap] of weekMap.entries()) {
    // Find leader for this week
    let leaderPuuid = '';
    let leaderCount = 0;
    for (const [puuid, count] of puuidMap.entries()) {
      if (count > leaderCount) {
        leaderCount = count;
        leaderPuuid = puuid;
      }
    }
    if (leaderCount < 1) continue;

    const { beatenForWeek } = await upsertWeeklyLeader(db as Parameters<typeof upsertWeeklyLeader>[0], {
      recordType: 'mvp_count_week',
      weekIso,
      riotPuuid: leaderPuuid,
      value: leaderCount,
    });
    if (beatenForWeek) seeded++;
  }

  console.log(`weekly mvp: seeded/updated ${seeded} weeks across ${weekMap.size} total weeks`);
}

// Weapons to exclude from kills_per_weapon backfill (same set as the detector)
const BACKFILL_EXCLUDED = new Set([
  'Vandal', 'Phantom', 'Knife', 'Fall',
  '9c82e19d-4575-0200-1a81-3eacf00cf872', // Vandal
  'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', // Phantom
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7', // Knife
]);

const BACKFILL_WEAPON_NAME: Record<string, string> = {
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

function backfillCanonicalWeapon(raw: string): string {
  return BACKFILL_WEAPON_NAME[raw] ?? raw;
}

interface KillEventCompact {
  round: number;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
  attacker_team: string;
  victim_team: string;
}

/**
 * Backfill kills_per_weapon records from existing match_records history.
 * For each match, parses kill_events_compact, groups kills by weapon for the community player,
 * and upserts into all_time_records with MAX semantics.
 * Idempotent — safe to run multiple times.
 */
async function backfillKillsPerWeapon() {
  const rows = await db
    .select({
      riot_puuid: matchRecords.riot_puuid,
      match_id: matchRecords.match_id,
      started_at: matchRecords.started_at,
      kill_events_compact: matchRecords.kill_events_compact,
    })
    .from(matchRecords)
    .where(isNotNull(matchRecords.riot_puuid));

  if (rows.length === 0) {
    console.log('kills_per_weapon: no match records yet, skipping');
    return;
  }

  let upserted = 0;
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
      const result = await upsertRecord(db as Parameters<typeof upsertRecord>[0], {
        recordType: 'kills_per_weapon',
        weapon,
        value: count,
        riotPuuid: puuid,
        matchId: row.match_id,
        achievedAt: row.started_at,
      });
      if (result.beaten) upserted++;
    }
  }

  console.log(`kills_per_weapon: processed ${rows.length} match rows, ${upserted} records upserted`);
}

await backfillKillsMatch();
await backfillDamageDealtMatch();
await backfillDamageReceivedMatch();
await backfillDeathsMatch();
await backfillHeadshotsMatch();
await backfillLegshotsMatch();
await backfillWeeklyMvpRecords();
await backfillKillsPerWeapon();
process.exit(0);
