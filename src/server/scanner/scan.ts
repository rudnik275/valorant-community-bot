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
} from '../lib/henrik.ts';
import { deriveMatchRecord, type MatchRecordInsert } from './derive.ts';
import { scannerEvents } from './events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
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
  // 1. Get user from DB
  const userRows = await db
    .select({
      riot_region: users.riot_region,
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
      const account = await getAccountByPuuid(puuid);
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
  try {
    const mmr = await getMmrByPuuid(puuid, region, 'console');
    await db
      .update(users)
      .set({
        current_tier_id: mmr.current.tier.id ?? null,
        current_tier_name: mmr.current.tier.name ?? null,
        peak_tier_id: mmr.peak?.tier?.id ?? null,
        peak_tier_name: mmr.peak?.tier?.name ?? null,
        peak_season_short: mmr.peak?.season ?? null,
        mmr_fetched_at: Date.now(),
      })
      .where(eq(users.riot_puuid, puuid));
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

  // 3. Fetch matches from Henrik v4 (console platform)
  let rawMatches;
  try {
    rawMatches = await getMatches(puuid, region, { platform: 'console', size: 5 });
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
