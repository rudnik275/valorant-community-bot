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

import { scannerEvents } from '../scanner/events.ts';
import { ALL_DETECTORS } from './detectors/index.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import type { MatchRecord } from './types.ts';
import logger from '../lib/log.ts';
import { getOpponentPeakRanks } from '../lib/opponent-context.ts';
import {
  getPrevRecords as getPrevRecordsQuery,
  getRegionForPuuid as getRegionForPuuidQuery,
  type SqliteDb,
} from '../db/queries.ts';

export interface DetectionDeps {
  db: SqliteDb;
  /** Injectable for testing; defaults to the typed `getPrevRecords` query. */
  getPrevRecords?: (puuid: string, beforeStartedAt: number) => Promise<MatchRecord[]>;
  /** Injectable for testing; defaults to the typed `getRegionForPuuid` query. */
  getRegionForPuuid?: (puuid: string) => Promise<string | null>;
  /**
   * Injectable for testing; defaults to the real getOpponentPeakRanks from opponent-context.ts.
   * Injecting this avoids module-level mock interference in test suites.
   */
  getOpponentPeakRanksFn?: typeof getOpponentPeakRanks;
}

/**
 * Start the detection listener. Returns a cleanup function to unsubscribe.
 */
export function startDetectionListener(deps: DetectionDeps): () => void {
  const { db } = deps;

  const handler = async (record: MatchRecord) => {
    try {
      const puuid = record.riot_puuid ?? '';

      // Fetch the last N previous match records for streak/comeback/promo
      // logic. Ordering / limit contract is documented in db/queries.ts.
      const prev: MatchRecord[] = deps.getPrevRecords
        ? await deps.getPrevRecords(puuid, record.started_at)
        : await getPrevRecordsQuery(db, puuid, record.started_at);

      // Single async detector contract. Each detector is run with allSettled
      // so one rejection (e.g. an opponent_peak Henrik failure or a thrown
      // sync detector) doesn't lose every other event for the same record.
      const detectorResults = await Promise.allSettled(
        ALL_DETECTORS.map((d) => d.detect(record, prev, { db })),
      );
      const eventsByDetector = detectorResults.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logger.warn(
          {
            module: 'detect',
            match_id: record.match_id,
            detector_type: ALL_DETECTORS[i]!.type,
            err: (r.reason as Error)?.message,
          },
          'Detector rejected — skipping this detector for this record',
        );
        return [];
      });

      // Per-detector enrichment (e.g. ace opponent-peak ranks). The
      // orchestrator no longer special-cases any event type or reaches into
      // payload internals — it resolves the region once, then lets each
      // detector enrich its OWN events behind the detector seam. allSettled
      // again so an enrichment failure can't drop other detectors' events.
      let region: string | null | undefined;
      const resolveRegion = async (): Promise<string | null> => {
        if (region === undefined) {
          region = deps.getRegionForPuuid
            ? await deps.getRegionForPuuid(puuid)
            : await getRegionForPuuidQuery(db, puuid);
        }
        return region;
      };
      const peakFn = deps.getOpponentPeakRanksFn ?? getOpponentPeakRanks;

      const enrichResults = await Promise.allSettled(
        ALL_DETECTORS.map(async (detector, i) => {
          const events = eventsByDetector[i]!;
          if (!detector.enrich || events.length === 0) return events;
          return detector.enrich(events, {
            db,
            riot_puuid: puuid,
            match_id: record.match_id,
            region: await resolveRegion(),
            getOpponentPeakRanksFn: peakFn,
          });
        }),
      );

      const allEvents = enrichResults.flatMap((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logger.warn(
          {
            module: 'detect',
            match_id: record.match_id,
            detector_type: ALL_DETECTORS[i]!.type,
            err: (r.reason as Error)?.message,
          },
          'Detector enrichment rejected — falling back to un-enriched events',
        );
        return eventsByDetector[i]!;
      });

      // Map of event_type → initial status. Default is 'pending' (realtime).
      const INITIAL_STATUS: Partial<Record<string, 'pending' | 'digest-only'>> = {
        winstreak_10plus: 'digest-only',
        record_kills_match: 'digest-only',
        record_deaths_match: 'digest-only',
        record_headshots_match: 'digest-only',
        record_legshots_match: 'digest-only',
        record_damage_dealt_match: 'digest-only',
        record_damage_received_match: 'digest-only',
        record_kills_per_weapon: 'digest-only',
        record_longest_match_minutes: 'digest-only',
      };

      // Insert all events. Each iteration is wrapped so a single CHECK / FK /
      // JSON.stringify failure doesn't drop subsequent events of the same record.
      for (const ev of allEvents) {
        try {
          const result = await db
            .insert(detectedEvents)
            .values({
              event_type: ev.type,
              riot_puuid: ev.riot_puuid,
              match_id: ev.match_id,
              payload_json: JSON.stringify(ev.payload),
              status: INITIAL_STATUS[ev.type] ?? 'pending',
            })
            .onConflictDoNothing();

          if (result.changes === 0) {
            logger.debug(
              { module: 'detect', event_type: ev.type, match_id: ev.match_id, riot_puuid: ev.riot_puuid },
              'Duplicate detected event skipped (UNIQUE conflict)',
            );
          }
        } catch (err) {
          logger.warn(
            { module: 'detect', event_type: ev.type, match_id: ev.match_id, err: (err as Error).message },
            'Failed to insert event — continuing with remaining events',
          );
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
