import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

const MS_PER_DAY = 86_400_000;
const PAUSE_THRESHOLD_DAYS = 14;

/**
 * Comeback detector: player returns after a pause of ≥14 days since their last match.
 *
 * Skipped if prevRecords is empty (first match after onboarding — no baseline).
 */
export const comebackDetector: Detector = {
  type: 'comeback',
  detect(record: MatchRecord, prevRecords: MatchRecord[]): DetectedEvent[] {
    const prev = prevRecords[0];
    if (!prev) return [];

    const daysSince = (record.started_at - prev.started_at) / MS_PER_DAY;
    if (daysSince < PAUSE_THRESHOLD_DAYS) return [];

    return [
      {
        type: 'comeback',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          days_paused: Math.round(daysSince),
        },
      },
    ];
  },
};
