// One-off: seed all_time_records from existing match_records history.
// Run AFTER db:migrate, BEFORE enabling record detectors in production.
// Idempotent — running twice does not corrupt.
//
// Usage:
//   ./scripts/with-secrets.sh bun run scripts/launch/backfill-records.ts

import { db } from '../../src/server/db/client.ts';
import { matchRecords } from '../../src/server/db/schema/match_records.ts';
import { allTimeRecords } from '../../src/server/db/schema/all_time_records.ts';
import { desc, isNotNull } from 'drizzle-orm';

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

await backfillKillsMatch();
process.exit(0);
