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
import { users } from '../db/schema/users.ts';
import type { MatchRecord } from './types.ts';
import logger from '../lib/log.ts';
import { getOpponentPeakRanks } from '../lib/opponent-context.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DetectionDeps {
  db: AnyDb;
  /** Injectable for testing; defaults to querying matchRecords table. */
  getPrevRecords?: (puuid: string, beforeStartedAt: number) => Promise<MatchRecord[]>;
  /** Injectable for testing; defaults to querying users table for riot_region. */
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

      // Run sync detectors — each is wrapped so one throw doesn't drop the rest.
      const allEventsSync = ALL_DETECTORS.flatMap((detector) => {
        try {
          return detector.detect(record, prev);
        } catch (err) {
          logger.warn(
            { module: 'detect', match_id: record.match_id, detector_type: detector.type, err: (err as Error).message },
            'Sync detector threw — skipping this detector for this record',
          );
          return [];
        }
      });
      // Run async detectors with allSettled so one rejection (e.g. opponent_peak
      // Henrik failure) doesn't lose every other event for the same record.
      const asyncDetectors = ALL_DETECTORS.filter((d) => d.detectAsync);
      const asyncResults = await Promise.allSettled(
        asyncDetectors.map((d) => d.detectAsync!(record, prev, { db })),
      );
      const allEventsAsync = asyncResults.flatMap((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logger.warn(
          {
            module: 'detect',
            match_id: record.match_id,
            detector_type: asyncDetectors[i]!.type,
            err: (r.reason as Error)?.message,
          },
          'Async detector rejected — skipping this detector for this record',
        );
        return [];
      });
      const allEvents = [...allEventsSync, ...allEventsAsync];

      // Augment ace/clutch events with opponents' peak ranks before insert
      const aceLikeEvents = allEvents.filter(
        (ev) => ev.type === 'ace',
      );

      if (aceLikeEvents.length > 0) {
        // Look up the region for this player
        const region: string | null = deps.getRegionForPuuid
          ? await deps.getRegionForPuuid(puuid)
          : await (async () => {
              const rows = await db
                .select({ riot_region: users.riot_region })
                .from(users)
                .where(eq(users.riot_puuid, puuid))
                .limit(1);
              return (rows[0]?.riot_region as string | null | undefined) ?? null;
            })();

        if (region) {
          // Collect all unique victims across ace/clutch events
          const seenPuuids = new Set<string>();
          const allVictims: Array<{ puuid: string; name: string; tag: string }> = [];
          for (const ev of aceLikeEvents) {
            const victims = ev.payload['victims'] as Array<{ puuid: string; name: string; tag: string }> | undefined;
            if (Array.isArray(victims)) {
              for (const v of victims) {
                if (!seenPuuids.has(v.puuid)) {
                  seenPuuids.add(v.puuid);
                  allVictims.push(v);
                }
              }
            }
          }

          if (allVictims.length > 0) {
            const peakFn = deps.getOpponentPeakRanksFn ?? getOpponentPeakRanks;
            const peakMap = await peakFn(allVictims, region);

            // Merge opponents_peak into each ace/clutch event payload
            for (const ev of aceLikeEvents) {
              const opponents_peak: Record<string, { tier_id: number; tier_name: string; season_short: string }> = {};
              for (const [victimPuuid, peak] of peakMap) {
                opponents_peak[victimPuuid] = peak;
              }
              ev.payload = { ...ev.payload, opponents_peak };
            }
          }
        } else {
          logger.warn(
            { module: 'detect', puuid, match_id: record.match_id },
            'No region found for player — skipping opponent peak augmentation',
          );
        }
      }

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
