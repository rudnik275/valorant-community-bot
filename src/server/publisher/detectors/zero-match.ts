import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Zero match detector: player finished a full match (≥10 rounds) with 0 kills.
 *
 * Minimum round threshold prevents false positives in very short/surrendered matches.
 */
export const zeroMatchDetector: Detector = {
  type: 'zero_match',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    if (record.kills !== 0 || record.rounds_played < 10) return [];

    return [
      {
        type: 'zero_match',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          rounds: record.rounds_played,
          deaths: record.deaths,
        },
      },
    ];
  },
};
