/**
 * detect.ts — Detection orchestrator.
 *
 * Subscribes to scannerEvents.newRecord (only emitted when detection:true),
 * runs all detectors, and persists results to detected_events with status='pending'.
 *
 * UNIQUE constraint on (match_id, event_type, riot_puuid) deduplicates via
 * onConflictDoNothing — no throws on duplicate inserts, only a debug log.
 *
 * Initial backfill from onboarding (scanForPuuid detection:false) does NOT
 * trigger detection because scanner never emits newRecord in that path.
 */

import { eq, and, lt, desc } from 'drizzle-orm';
import { scannerEvents } from '../scanner/events.ts';
import { ALL_DETECTORS } from './detectors/index.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import type { MatchRecord } from './types.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DetectionDeps {
  db: AnyDb;
  /** Injectable for testing; defaults to querying matchRecords table. */
  getPrevRecords?: (puuid: string, beforeStartedAt: number) => Promise<MatchRecord[]>;
}

/**
 * Start the detection listener. Returns a cleanup function to unsubscribe.
 */
export function startDetectionListener(deps: DetectionDeps): () => void {
  const { db } = deps;

  const handler = async (record: MatchRecord) => {
    try {
      const puuid = record.riot_puuid ?? '';

      // Fetch last 30 previous match records for streak/comeback/promo logic
      const prev: MatchRecord[] = deps.getPrevRecords
        ? await deps.getPrevRecords(puuid, record.started_at)
        : await db
            .select()
            .from(matchRecords)
            .where(
              and(
                eq(matchRecords.riot_puuid, puuid),
                lt(matchRecords.started_at, record.started_at),
              ),
            )
            .orderBy(desc(matchRecords.started_at))
            .limit(30);

      for (const detector of ALL_DETECTORS) {
        const events = detector.detect(record, prev);
        for (const ev of events) {
          const result = await db
            .insert(detectedEvents)
            .values({
              event_type: ev.type,
              riot_puuid: ev.riot_puuid,
              match_id: ev.match_id,
              payload_json: JSON.stringify(ev.payload),
            })
            .onConflictDoNothing();

          if (result.changes === 0) {
            logger.debug(
              { module: 'detect', event_type: ev.type, match_id: ev.match_id, riot_puuid: ev.riot_puuid },
              'Duplicate detected event skipped (UNIQUE conflict)',
            );
          }
        }
      }

      logger.info(
        { module: 'detect', match_id: record.match_id, puuid },
        'Detection complete',
      );
    } catch (err) {
      logger.error(
        { module: 'detect', err, match_id: record.match_id },
        'Detection failed',
      );
    }
  };

  scannerEvents.on('newRecord', handler);
  return () => scannerEvents.off('newRecord', handler);
}
