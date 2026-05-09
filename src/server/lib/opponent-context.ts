/**
 * opponent-context.ts — Fetches opponents' peak MMR ranks for ace/clutch events.
 *
 * Uses a 24-hour in-memory TTL cache keyed by PUUID to avoid hammering Henrik.
 * Handles rate-limit, not-found, and upstream errors gracefully.
 */

import { getMmrByPuuid, HenrikNotFoundError, HenrikRateLimitError, HenrikUpstreamError } from './henrik.ts';
import logger from './log.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpponentPeak {
  tier_id: number;
  tier_name: string;
  season_short: string;
}

interface CacheEntry {
  peak: OpponentPeak;
  fetchedAt: number;
}

export interface Victim {
  puuid: string;
  name: string;
  tag: string;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

/** Default TTL: 24 hours in milliseconds. */
export const OPPONENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/** Clear the in-memory cache — for test isolation only. */
export function clearOpponentCache(): void {
  cache.clear();
}

function isStale(entry: CacheEntry, now: number, ttlMs: number): boolean {
  return now - entry.fetchedAt >= ttlMs;
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch peak ranks for a list of opponents.
 *
 * - Cache hits (< 24h) are returned without an API call.
 * - 200ms throttle between API calls to be polite to Henrik.
 * - HenrikNotFoundError: skip that puuid (omit from result).
 * - HenrikRateLimitError: abort loop, return what we have, warn.
 * - HenrikUpstreamError: skip individual call, log, continue.
 *
 * Returns a Map<puuid, OpponentPeak>; some puuids may be absent — callers handle gracefully.
 */
export async function getOpponentPeakRanks(
  victims: Victim[],
  region: string,
  opts?: { platform?: 'pc' | 'console'; ttlMs?: number },
): Promise<Map<string, OpponentPeak>> {
  const platform = opts?.platform ?? 'console';
  const ttlMs = opts?.ttlMs ?? OPPONENT_CACHE_TTL_MS;
  const now = Date.now();

  const result = new Map<string, OpponentPeak>();
  let firstMiss = true;

  for (const victim of victims) {
    const { puuid } = victim;

    // Cache hit?
    const cached = cache.get(puuid);
    if (cached && !isStale(cached, now, ttlMs)) {
      result.set(puuid, cached.peak);
      continue;
    }

    // Throttle: sleep 200ms between API calls (skip before the first miss)
    if (!firstMiss) {
      await sleep(200);
    }
    firstMiss = false;

    try {
      const mmr = await getMmrByPuuid(puuid, region, platform);
      if (mmr.peak) {
        const peak: OpponentPeak = {
          tier_id: mmr.peak.tier.id,
          tier_name: mmr.peak.tier.name,
          season_short: mmr.peak.season ?? '',
        };
        cache.set(puuid, { peak, fetchedAt: now });
        result.set(puuid, peak);
      }
      // If mmr.peak is null (unranked), omit from result — no peak data to show.
    } catch (err) {
      if (err instanceof HenrikNotFoundError) {
        // Unknown player — skip silently
        logger.debug({ module: 'opponent-context', puuid }, 'Opponent not found in Henrik — skipping');
      } else if (err instanceof HenrikRateLimitError) {
        logger.warn(
          { module: 'opponent-context', retryAfter: err.retryAfter, resolvedSoFar: result.size },
          'Henrik rate limit hit — aborting opponent peak lookup, returning partial results',
        );
        return result;
      } else if (err instanceof HenrikUpstreamError) {
        logger.warn(
          { module: 'opponent-context', puuid, status: err.status, err },
          'Henrik upstream error for opponent — skipping',
        );
      } else {
        logger.warn(
          { module: 'opponent-context', puuid, err },
          'Unexpected error fetching opponent MMR — skipping',
        );
      }
    }
  }

  return result;
}
