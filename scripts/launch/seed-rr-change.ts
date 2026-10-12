// One-off admin: seed match_records.rr_change / rank_before from Henrik
// mmr-history so «🏦 RR недели» (#388) has data for matches the scanner
// recorded before it started storing RR (#384).
//
// Behaviour:
//   - One /v2/by-puuid/mmr-history call per member with a PUUID + region
//     (last 20 ranked matches each), 2 s apart, through the same metered
//     Henrik client as the scanner (background priority) — the API key is
//     shared with the live scanner.
//   - Writes Riot's RR change + tier-before onto the matching
//     (match_id, riot_puuid) row, ONLY where rr_change is still null — rows
//     the scanner already filled are left alone, so a re-run is a no-op.
//   - A member whose fetch fails is logged and skipped; the run continues.
//
// Dry-run by default. Set APPLY=1 to actually write.
//
// Run via:
//   gh workflow run seed-rr-change.yml -f apply=1
// or directly:
//   docker exec -e APPLY=1 valorant-bot-app bun run scripts/launch/seed-rr-change.ts

import { db } from '../../src/server/db/client.ts';
import { getMmrHistoryByPuuid } from '../../src/server/lib/henrik.ts';
import { seedRrChange } from '../../src/server/scanner/seed-rr-change.ts';

const APPLY = process.env['APPLY'] === '1';

console.log(`Mode: ${APPLY ? 'APPLY (writing rr_change / rank_before)' : 'DRY-RUN'}`);

const result = await seedRrChange(db, {
  fetchHistory: (puuid, region) =>
    getMmrHistoryByPuuid(puuid, region, 'console', { priority: 'background' }),
  apply: APPLY,
});

console.log('\n=== Summary ===');
console.log(`Members asked: ${result.users}`);
console.log(`Members skipped (fetch failed): ${result.skipped}`);
console.log(`Null rr_change rows matched: ${result.candidates}`);
console.log(`Rows written: ${result.updated}`);

if (!APPLY) console.log('\nDry-run. Re-run with APPLY=1 to write.');
process.exit(0);
