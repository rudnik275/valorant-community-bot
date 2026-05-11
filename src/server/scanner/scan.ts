/**
 * scan.ts — Per-PUUID scan: fetch recent matches from Henrik, derive compact
 * records, dedup against existing rows, and insert new ones.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  getMatches,
  getAccountByPuuid,
  getMmrByPuuid,
  HenrikRateLimitError,
  HenrikNotFoundError,
  HenrikUpstreamError,
  type Priority,
} from '../lib/henrik.ts';
import { deriveMatchRecord, deriveMatchRoster, type MatchRecordInsert } from './derive.ts';
import { scannerEvents } from './events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { matchRosters } from '../db/schema/match_rosters.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** Queue ID for console-competitive matches (the only queue we process). */
export const CONSOLE_COMPETITIVE_QUEUE = 'console_competitive';

export interface ScanResult {
  newRecords: MatchRecordInsert[];
  skippedDuplicates: number;
}

export interface ScanOpts {
  /** When true, emit 'newRecord' events for each new match record (for event detection). */
  detection: boolean;
  /**
   * Priority for the three Henrik calls made during this scan. Default 'background'.
   * Set to 'interactive' for user-triggered scans (onboard, manual refresh) so they
   * jump ahead of the cron sweep in the Henrik queue.
   */
  priority?: Priority;
}

/**
 * Scan a single user's recent competitive matches and persist new ones.
 *
 * - Fetches last 5 console_competitive matches from Henrik v4.
 * - Filters client-side: only metadata.queue.id === CONSOLE_COMPETITIVE_QUEUE.
 * - Skips any that already exist in match_records (dedup by match_id + riot_puuid).
 * - Inserts new records via UPSERT (onConflictDoNothing).
 * - If detection=true, emits 'newRecord' on scannerEvents for each new record.
 * - Handles HenrikRateLimitError, HenrikNotFoundError, HenrikUpstreamError
 *   gracefully (log + return empty result). Re-throws unexpected errors.
 */
export async function scanForPuuid(
  db: AnyDb,
  puuid: string,
  opts: ScanOpts,
): Promise<ScanResult> {
  const priority: Priority = opts.priority ?? 'background';
  // 1. Get user from DB
  const userRows = await db
    .select({
      riot_region: users.riot_region,
      peak_tier_id: users.peak_tier_id,
      peak_tier_name: users.peak_tier_name,
    })
    .from(users)
    .where(eq(users.riot_puuid, puuid))
    .limit(1);

  const user = userRows[0] ?? null;

  if (!user) {
    logger.warn({ module: 'scanner', puuid }, 'scanForPuuid: user not found in DB — skipping');
    return { newRecords: [], skippedDuplicates: 0 };
  }

  // 2. Lazy backfill: if riot_region is null, fetch from Henrik by PUUID
  let region = user.riot_region as string | null;
  if (!region) {
    try {
      logger.info({ module: 'scanner', puuid }, 'riot_region is null — fetching from Henrik (lazy backfill)');
      const account = await getAccountByPuuid(puuid, { priority });
      region = account.region;
      // Persist to DB
      await db
        .update(users)
        .set({ riot_region: region })
        .where(eq(users.riot_puuid, puuid));
      logger.info({ module: 'scanner', puuid, region }, 'riot_region backfilled');
    } catch (err) {
      if (
        err instanceof HenrikRateLimitError ||
        err instanceof HenrikNotFoundError ||
        err instanceof HenrikUpstreamError
      ) {
        logger.warn({ module: 'scanner', puuid, err }, 'Could not backfill riot_region — skipping scan');
        return { newRecords: [], skippedDuplicates: 0 };
      }
      throw err;
    }
  }

  // 2.5. Fetch current + peak rank from Henrik MMR (fire-and-forget UPDATE).
  // We don't block the scan on MMR errors — match scan can continue.
  // Never overwrite an existing DB value with null — last-known-good wins until
  // Henrik returns a real new value. True "unranked" is tier_id 0, not null.
  // mmr_fetched_at always updates as a liveness probe.
  const oldPeakTierId = user.peak_tier_id as number | null;
  const oldPeakTierName = user.peak_tier_name as string | null;
  try {
    const mmr = await getMmrByPuuid(puuid, region, 'console', { priority });
    const mmrUpdate: Partial<typeof users.$inferInsert> = {
      mmr_fetched_at: Date.now(),
    };
    if (mmr.current?.tier?.id != null) {
      mmrUpdate.current_tier_id = mmr.current.tier.id;
      mmrUpdate.current_tier_name = mmr.current.tier.name ?? null;
    }
    if (mmr.peak?.tier?.id != null) {
      mmrUpdate.peak_tier_id = mmr.peak.tier.id;
      mmrUpdate.peak_tier_name = mmr.peak.tier.name ?? null;
      mmrUpdate.peak_season_short = mmr.peak.season ?? null;

      // peak_rank_up event: emit only when we have a prior peak in DB and the new
      // peak strictly exceeds it. Gated on opts.detection so onboarding bulk
      // scans don't fire historical events.
      // status='digest-only' — consumed by the weekly digest, no realtime push.
      if (
        opts.detection &&
        oldPeakTierId != null &&
        mmr.peak.tier.id > oldPeakTierId
      ) {
        await db
          .insert(detectedEvents)
          .values({
            event_type: 'peak_rank_up',
            riot_puuid: puuid,
            match_id: `peak:${mmr.peak.tier.id}`,
            payload_json: JSON.stringify({
              from_tier_id: oldPeakTierId,
              from_tier_name: oldPeakTierName,
              to_tier_id: mmr.peak.tier.id,
              to_tier_name: mmr.peak.tier.name ?? null,
            }),
            status: 'digest-only',
          })
          .onConflictDoNothing();
      }
    }
    await db.update(users).set(mmrUpdate).where(eq(users.riot_puuid, puuid));
  } catch (err) {
    if (
      err instanceof HenrikRateLimitError ||
      err instanceof HenrikNotFoundError ||
      err instanceof HenrikUpstreamError
    ) {
      logger.warn({ module: 'scanner', puuid, err: (err as Error).message }, 'MMR fetch failed — continuing with match scan');
    } else {
      logger.warn({ module: 'scanner', puuid, err }, 'unexpected MMR error — continuing');
    }
  }

  // 2.6. Refresh account info (riot_card_id) on every scan tick.
  // Only write if Henrik returned a non-null cardId — preserve last-known-good otherwise.
  try {
    const account = await getAccountByPuuid(puuid, { priority });
    if (account.cardId != null) {
      await db
        .update(users)
        .set({ riot_card_id: account.cardId })
        .where(eq(users.riot_puuid, puuid));
    }
  } catch (err) {
    if (
      err instanceof HenrikRateLimitError ||
      err instanceof HenrikNotFoundError ||
      err instanceof HenrikUpstreamError
    ) {
      logger.warn({ module: 'scanner', puuid, err: (err as Error).message }, 'Account info refresh failed — continuing');
    } else {
      logger.warn({ module: 'scanner', puuid, err }, 'unexpected account info error — continuing');
    }
  }

  // 3. Fetch matches from Henrik v4 (console platform)
  let rawMatches;
  try {
    rawMatches = await getMatches(puuid, region, { platform: 'console', size: 5, priority });
  } catch (err) {
    if (
      err instanceof HenrikRateLimitError ||
      err instanceof HenrikNotFoundError ||
      err instanceof HenrikUpstreamError
    ) {
      logger.warn({ module: 'scanner', puuid, err }, 'Henrik error during getMatches — skipping');
      return { newRecords: [], skippedDuplicates: 0 };
    }
    throw err;
  }

  // 4. Filter: only console_competitive queue
  const competitiveMatches = rawMatches.filter(
    (m) => m.metadata.queue?.id === CONSOLE_COMPETITIVE_QUEUE,
  );

  if (competitiveMatches.length === 0) {
    return { newRecords: [], skippedDuplicates: 0 };
  }

  // 5. Derive compact records (null if player not found in match)
  const derived = competitiveMatches
    .map((m) => deriveMatchRecord(m, puuid))
    .filter((r): r is MatchRecordInsert => r !== null);

  if (derived.length === 0) {
    return { newRecords: [], skippedDuplicates: 0 };
  }

  // 6. Check which match_ids already exist
  const matchIds = derived.map((r) => r.match_id);
  const existingRows = await db
    .select({ match_id: matchRecords.match_id })
    .from(matchRecords)
    .where(
      inArray(matchRecords.match_id, matchIds),
    );

  const existingIds = new Set(existingRows.map((r: { match_id: string }) => r.match_id));

  const toInsert = derived.filter((r) => !existingIds.has(r.match_id));
  const skippedDuplicates = derived.length - toInsert.length;

  if (toInsert.length === 0) {
    return { newRecords: [], skippedDuplicates };
  }

  // 7. Insert new records (UPSERT for safety — onConflictDoNothing on PK)
  await db
    .insert(matchRecords)
    .values(toInsert)
    .onConflictDoNothing();

  // 7b. Insert rosters for ALL players in new matches (PK dedupes if same match
  //     scanned for multiple community players — onConflictDoNothing handles it).
  const rosterRows = toInsert.flatMap((r) => {
    const match = competitiveMatches.find((m) => m.metadata.match_id === r.match_id);
    return match ? deriveMatchRoster(match) : [];
  });
  if (rosterRows.length > 0) {
    await db
      .insert(matchRosters)
      .values(rosterRows)
      .onConflictDoNothing();
  }

  // 8. Emit events if detection mode is enabled
  if (opts.detection) {
    for (const record of toInsert) {
      scannerEvents.emit('newRecord', record);
    }
  }

  logger.info(
    { module: 'scanner', puuid, new: toInsert.length, skipped: skippedDuplicates },
    'scan complete',
  );

  return { newRecords: toInsert, skippedDuplicates };
}
