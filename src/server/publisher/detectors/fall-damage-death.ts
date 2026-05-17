import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Fall damage death detector: player killed at least one enemy with fall damage.
 *
 * Note: `fall_damage_kills` tracks kills delivered to others via fall damage
 * (i.e., the player caused fall damage kills), per the schema convention.
 * Emits ONE event per match even if count > 1.
 */
export const fallDamageDeathDetector: Detector = {
  type: 'fall_damage_death',
  async detect(record: MatchRecord, _prevRecords: MatchRecord[]): Promise<DetectedEvent[]> {
    if (record.fall_damage_kills < 1) return [];

    return [
      {
        type: 'fall_damage_death',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          count: record.fall_damage_kills,
        },
      },
    ];
  },
};
