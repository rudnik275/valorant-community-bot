// One-off admin: replay all detectors over historical match_records.
//
// Use after a backfill into match_records to populate detected_events that
// the scanner never emitted (because detection fires only when scan.ts
// itself inserts a new row, not when a row arrives via a different path).
//
// Behaviour:
//   - Iterates match_records in started_at ASC order.
//   - For each record, fetches up to 30 previous records for streak/comeback context.
//   - Runs every sync + async detector from ALL_DETECTORS.
//   - Inserts events with status='digest-only' so they never trigger realtime
//     publishing — they'll only ever appear in the next digest if they fall
//     inside the digest window.
//   - All inserts use onConflictDoNothing on the (match_id, event_type, riot_puuid)
//     UNIQUE index, so events already emitted by live scans are left untouched.
//
// Dry-run by default. Set APPLY=1 to actually write detected_events.
// Optional: SINCE=<ms since epoch> to limit scope to records started after that.
//
// Run via:
//   docker exec -e APPLY=1 valorant-bot-app bun run scripts/launch/replay-detectors.ts
// or via the workflow_dispatch action.

import { eq, and, lt, gte, desc, asc, isNotNull } from 'drizzle-orm';
import { db } from '../../src/server/db/client.ts';
import { matchRecords } from '../../src/server/db/schema/match_records.ts';
import { detectedEvents } from '../../src/server/db/schema/detected_events.ts';
import { ALL_DETECTORS } from '../../src/server/publisher/detectors/index.ts';
import type { MatchRecord } from '../../src/server/publisher/types.ts';

const APPLY = process.env['APPLY'] === '1';
const SINCE = process.env['SINCE'] ? Number(process.env['SINCE']) : 0;
const PREV_WINDOW = 30;

console.log(`Mode: ${APPLY ? 'APPLY (writing detected_events)' : 'DRY-RUN'}`);
if (SINCE) console.log(`Filtering to records with started_at >= ${new Date(SINCE).toISOString()}`);

const allRecords = (await db
  .select()
  .from(matchRecords)
  .where(
    and(
      isNotNull(matchRecords.riot_puuid),
      SINCE ? gte(matchRecords.started_at, SINCE) : undefined,
    ),
  )
  .orderBy(asc(matchRecords.started_at))) as MatchRecord[];

console.log(`Records to replay: ${allRecords.length}`);

const eventTypeCounts = new Map<string, number>();
let totalEventsWritten = 0;
let totalEventsSkippedDupe = 0;
let processed = 0;

for (const record of allRecords) {
  const puuid = record.riot_puuid;
  if (!puuid) continue;

  const prev = (await db
    .select()
    .from(matchRecords)
    .where(
      and(
        eq(matchRecords.riot_puuid, puuid),
        lt(matchRecords.started_at, record.started_at),
      ),
    )
    .orderBy(desc(matchRecords.started_at))
    .limit(PREV_WINDOW)) as MatchRecord[];

  const sync = ALL_DETECTORS.flatMap((d) => d.detect(record, prev));
  const asyncEvts = (await Promise.all(
    ALL_DETECTORS.filter((d) => d.detectAsync).map((d) => d.detectAsync!(record, prev, { db })),
  )).flat();
  const events = [...sync, ...asyncEvts];

  for (const ev of events) {
    eventTypeCounts.set(ev.type, (eventTypeCounts.get(ev.type) ?? 0) + 1);

    if (APPLY) {
      const result = await db
        .insert(detectedEvents)
        .values({
          event_type: ev.type,
          riot_puuid: ev.riot_puuid,
          match_id: ev.match_id,
          payload_json: JSON.stringify(ev.payload),
          status: 'digest-only',
        })
        .onConflictDoNothing();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const changes = (result as any)?.changes ?? 0;
      if (changes > 0) totalEventsWritten++;
      else totalEventsSkippedDupe++;
    } else {
      totalEventsWritten++;
    }
  }

  processed++;
  if (processed % 50 === 0) {
    console.log(`  ... processed ${processed}/${allRecords.length} records, ${totalEventsWritten} events ${APPLY ? 'written' : 'would be written'}`);
  }
}

console.log('\n=== Summary ===');
console.log(`Records processed: ${processed}`);
console.log(`Events ${APPLY ? 'written (new)' : 'detected (dry-run)'}: ${totalEventsWritten}`);
if (APPLY) console.log(`Events skipped as duplicates of existing: ${totalEventsSkippedDupe}`);
console.log('\nBreakdown by event_type:');
const sorted = Array.from(eventTypeCounts.entries()).sort((a, b) => b[1] - a[1]);
for (const [type, count] of sorted) {
  console.log(`  ${count.toString().padStart(5)} · ${type}`);
}

if (!APPLY) console.log('\nDry-run. Re-run with APPLY=1 to insert events with status=digest-only.');
process.exit(0);
