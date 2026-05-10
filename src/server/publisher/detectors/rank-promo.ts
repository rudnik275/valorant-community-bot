import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';
import { getCurrentActStart } from '../../lib/valorant-seasons.ts';

/**
 * Tier numeric order. Used to detect tier-up (promotion to new tier).
 * Division (e.g., "Diamond 1" vs "Diamond 3") is NOT checked — only tier.
 */
const TIER_ORDER: Record<string, number> = {
  Iron: 1,
  Bronze: 2,
  Silver: 3,
  Gold: 4,
  Platinum: 5,
  Diamond: 6,
  Ascendant: 7,
  Immortal: 8,
  Radiant: 9,
};

/**
 * Extract the tier name from a rank string like "Diamond 3" → "Diamond".
 * Returns null if the string is unrecognizable.
 */
function extractTier(rank: string | null | undefined): string | null {
  if (!rank) return null;
  const tier = rank.split(' ')[0];
  return tier && tier in TIER_ORDER ? tier : null;
}

/**
 * Rank promotion detector.
 *
 * Fires when the player's tier exceeds their season peak (e.g., Diamond → Ascendant
 * for the first time this season). Does NOT fire on:
 *   - Division increases within same tier (Diamond 1 → Diamond 2)
 *   - Rank decreases
 *   - Re-achieving a tier already reached this season (drop + re-climb)
 *   - First match (no prev baseline, handled via maxPrevTierNum = 0)
 */
export const rankPromoDetector: Detector = {
  type: 'rank_promo',
  detect(record: MatchRecord, prevRecords: MatchRecord[]): DetectedEvent[] {
    const seasonStart = getCurrentActStart();
    const seasonPrev = prevRecords.filter((r) => r.started_at >= seasonStart);

    // Empty seasonPrev → maxPrevTierNum = 0 (first competitive match this season fires correctly).
    const maxPrevTierNum = seasonPrev
      .map((r) => extractTier(r.rank_after))
      .filter((t): t is string => t !== null)
      .map((t) => TIER_ORDER[t]!)
      .reduce((a, b) => Math.max(a, b), 0);

    const currTier = extractTier(record.rank_after);
    if (!currTier) return [];
    const currNum = TIER_ORDER[currTier]!;
    if (currNum <= maxPrevTierNum) return [];

    // payload.from uses the immediate-prev rank (so message reads "Diamond 3 → Ascendant 1",
    // not the season-max rank which could be older).
    const immediatePrev = prevRecords[0];

    return [
      {
        type: 'rank_promo',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          from: immediatePrev?.rank_after ?? null,
          to: record.rank_after,
          from_tier: extractTier(immediatePrev?.rank_after),
          to_tier: currTier,
        },
      },
    ];
  },
};
