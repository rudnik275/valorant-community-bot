import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Numeric tier mapping. Matches the same scale used by rank_promo detector.
 * Supports both "Diamond" and "Diamond 2" formats (split on space, take first word).
 */
const TIER_NUMERIC: Record<string, number> = {
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

function rankToNumeric(rank: string | null | undefined): number | null {
  if (!rank) return null;
  const tier = rank.split(' ')[0];
  return tier && tier in TIER_NUMERIC ? (TIER_NUMERIC[tier] ?? null) : null;
}

/**
 * Giant Slayer detector: player wins against a team whose average rank is
 * ≥1.5 tiers above the player's own rank.
 */
export const giantSlayerDetector: Detector = {
  type: 'giant_slayer',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    if (record.result !== 'win') return [];

    const ownNumeric = rankToNumeric(record.rank_after);
    const enemyNumeric = rankToNumeric(record.enemy_avg_rank);

    if (ownNumeric === null || enemyNumeric === null) return [];

    const delta = enemyNumeric - ownNumeric;
    if (delta < 1.5) return [];

    return [
      {
        type: 'giant_slayer',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          own: record.rank_after,
          enemy_avg: record.enemy_avg_rank,
          delta,
        },
      },
    ];
  },
};
