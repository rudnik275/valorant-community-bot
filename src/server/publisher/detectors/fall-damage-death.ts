import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Environmental-death detector: the player died at least once with no killer —
 * fall damage and any other source Riot does not name (see derive.ts for how
 * that is read off the Henrik payload). Spike and ability self-kills are
 * excluded there.
 *
 * The old doc here claimed the opposite ("player killed an enemy with fall
 * damage"); the column has always counted the player's OWN deaths, which is
 * what the «1:0 в пользу гравитации» template renders.
 *
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
