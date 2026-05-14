/**
 * scan.ts — Per-PUUID scan: fetch recent matches from Henrik, derive compact
 * records, dedup against existing rows, and insert new ones.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  getMatches,
  getAccountByPuuid,
  getMmrByPuuid,
  HenrikRateLimitError,
  HenrikNotFoundError,
  HenrikUpstreamError,
  HenrikInactiveAccountError,
  type Priority,
  type HenrikMatchV4,
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
 * - Fetches last 10 console matches from Henrik v4 (filtered client-side to
 *   console_competitive). size=10 + 15-min cron gives a generous recovery
 *   window — a user would need to sustain 10 ranked matches in 15 minutes
 *   to outpace it, which is physically impossible (rounds last 30+ min).
 * - Skips any that already exist in match_records (dedup by (riot_puuid, match_id)).
 * - Inserts new records via UPSERT (onConflictDoNothing).
 * - If detection=true, emits 'newRecord' on scannerEvents for each new record.
 * - Handles HenrikRateLimitError, HenrikNotFoundError, HenrikUpstreamError,
 *   HenrikInactiveAccountError gracefully (log + return empty result).
 *   Re-throws unexpected errors.
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
        err instanceof HenrikUpstreamError ||
        err instanceof HenrikInactiveAccountError
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
      err instanceof HenrikUpstreamError ||
      err instanceof HenrikInactiveAccountError
    ) {
      logger.warn({ module: 'scanner', puuid, err: (err as Error).message }, 'MMR fetch failed — continuing with match scan');
    } else {
      logger.warn({ module: 'scanner', puuid, err }, 'unexpected MMR error — continuing');
    }
  }

  // 3. Fetch matches from Henrik v4 (console platform).
  // size=10 + 15-min cron gives ~4x the recovery window vs. the old size=5 + 30-min.
  // Real ranked matches are 30–45 min each, so 10 matches in 15 min is unreachable
  // in practice — older matches no longer roll off Henrik's window between ticks.
  let rawMatches;
  try {
    rawMatches = await getMatches(puuid, region, { platform: 'console', size: 10, priority });
  } catch (err) {
    if (
      err instanceof HenrikRateLimitError ||
      err instanceof HenrikNotFoundError ||
      err instanceof HenrikUpstreamError ||
      err instanceof HenrikInactiveAccountError
    ) {
      logger.warn({ module: 'scanner', puuid, err }, 'Henrik error during getMatches — skipping');
      return { newRecords: [], skippedDuplicates: 0 };
    }
    throw err;
  }

  // 3b. Successful Henrik round-trip — clear any stale "lookup failed" flag.
  await db
    .update(users)
    .set({ riot_lookup_failed_since: null })
    .where(eq(users.riot_puuid, puuid));

  // 3c. Match-driven profile sync for the scan target only.
  // Every match's `players[]` carries the loadout-at-match-time (card, name, tag)
  // for the player. We use this as source-of-truth instead of `account/by-puuid`
  // whose `card`/`name`/`tag` are lazily updated by Riot and can stay stale for days.
  //
  // ONLY the scan target's row is touched — earlier versions also refreshed
  // friends seen in the same lobby, but that regressed data: a friend who
  // recently changed their card could be downgraded back to their card from
  // some week-old joint match if the friend's own scan happened to run later
  // in the same tick. Each user's own matches are their absolute-freshest
  // source; cross-friend updates are not.
  await syncProfileFromMatches(db, puuid, rawMatches);

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

  // 6. Check which match_ids already exist for THIS puuid.
  // The PK is (riot_puuid, match_id), so the same match has one row per
  // community player. We must scope the existence check by puuid — otherwise
  // a row inserted earlier for a friend in the same lobby would mask this
  // user's missing record and the scanner would silently skip them.
  const matchIds = derived.map((r) => r.match_id);
  const existingRows = await db
    .select({ match_id: matchRecords.match_id })
    .from(matchRecords)
    .where(
      and(
        eq(matchRecords.riot_puuid, puuid),
        inArray(matchRecords.match_id, matchIds),
      ),
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

/**
 * Match-driven profile sync for one specific puuid (the scan target).
 *
 * Walks the scan target's player entry across all matches newest→oldest and
 * picks the first non-null `customization.card` / `name` / `tag` (each field
 * tracked independently — Henrik sometimes omits `customization` for a player
 * in a given match, so a strictly-latest-match approach would miss real card
 * data sitting one match older). UPDATEs the target's row. Last-known-good
 * for each field — never overwrite a real value with null. Writes only fields
 * that actually differ.
 */
async function syncProfileFromMatches(db: AnyDb, puuid: string, matches: HenrikMatchV4[]): Promise<void> {
  if (matches.length === 0) return;

  // Iterate newest-first so the first non-null observation per field wins.
  const sorted = [...matches].sort((a, b) => {
    const aT = a.metadata.started_at ? Date.parse(a.metadata.started_at) : 0;
    const bT = b.metadata.started_at ? Date.parse(b.metadata.started_at) : 0;
    return bT - aT;
  });

  const obs: { card: string | null; name: string | null; tag: string | null } = { card: null, name: null, tag: null };
  for (const m of sorted) {
    const p = m.players.find((pl) => pl.puuid === puuid);
    if (!p) continue;
    if (obs.card == null && p.customization?.card != null) obs.card = p.customization.card;
    if (obs.name == null && p.name != null) obs.name = p.name;
    if (obs.tag == null && p.tag != null) obs.tag = p.tag;
    if (obs.card != null && obs.name != null && obs.tag != null) break;
  }

  if (obs.card == null && obs.name == null && obs.tag == null) return;

  const [row]: Array<{ riot_card_id: string | null; riot_name: string | null; riot_tag: string | null }> = await db
    .select({
      riot_card_id: users.riot_card_id,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
    })
    .from(users)
    .where(eq(users.riot_puuid, puuid))
    .limit(1);
  if (!row) return;

  const patch: Partial<typeof users.$inferInsert> = {};
  if (obs.card != null && obs.card !== row.riot_card_id) patch.riot_card_id = obs.card;
  if (obs.name != null && obs.name !== row.riot_name) patch.riot_name = obs.name;
  if (obs.tag != null && obs.tag !== row.riot_tag) patch.riot_tag = obs.tag;
  if (Object.keys(patch).length === 0) return;

  await db.update(users).set(patch).where(eq(users.riot_puuid, puuid));
  logger.info(
    { module: 'scanner', puuid, fields: Object.keys(patch) },
    'profile updated from match data',
  );
}
