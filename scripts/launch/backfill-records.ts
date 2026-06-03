// One-off: seed all_time_records and weekly_records from existing match_records history.
// Run AFTER db:migrate, BEFORE enabling record detectors in production.
// Idempotent — running twice does not corrupt (clears then rebuilds).
//
// Usage:
//   with-secrets bun run scripts/launch/backfill-records.ts

import { db } from '../../src/server/db/client.ts';
import { rebuildAllRecords } from '../../src/server/publisher/records-rebuild.ts';

await rebuildAllRecords(db);
process.exit(0);
