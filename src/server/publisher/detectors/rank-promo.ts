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
 * Fires when the player's tier increases (e.g., Diamond → Ascendant).
 * Does NOT fire on:
 *   - Division increases within same tier (Diamond 1 → Diamond 2)
 *   - Rank decreases
 *   - First match (no prev baseline)
 *   - Cross-season comparison (prev match started before current act)
 */
export const rankPromoDetector: Detector = {
  type: 'rank_promo',
  detect(record: MatchRecord, prevRecords: MatchRecord[]): DetectedEvent[] {
    const prev = prevRecords[0];
    if (!prev) return [];

    // Skip cross-season rank comparison
    if (prev.started_at < getCurrentActStart()) return [];

    const prevTier = extractTier(prev.rank_after);
    const currTier = extractTier(record.rank_after);

    if (!prevTier || !currTier) return [];

    const prevNum = TIER_ORDER[prevTier]!;
    const currNum = TIER_ORDER[currTier]!;

    if (currNum <= prevNum) return [];

    return [
      {
        type: 'rank_promo',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          from: prev.rank_after,
          to: record.rank_after,
          from_tier: prevTier,
          to_tier: currTier,
        },
      },
    ];
  },
};
