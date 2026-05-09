import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Lostrick detector: fires exactly when the player reaches a 9-loss streak.
 *
 * Mirror of winstreak_9. Counts consecutive losses in [record, ...prevRecords]
 * sorted desc by started_at. Draw or win breaks the streak.
 * Emits ONLY when streak === 9 to avoid duplicate events on longer streaks.
 */
export const lostrickDetector: Detector = {
  type: 'lostrick_9',
  detect(record: MatchRecord, prevRecords: MatchRecord[]): DetectedEvent[] {
    const allRecords = [record, ...prevRecords].sort(
      (a, b) => b.started_at - a.started_at,
    );

    let streak = 0;

    for (const r of allRecords) {
      if (r.result === 'loss') {
        streak++;
      } else {
        break;
      }
    }

    // Emit only at the exact threshold of 9 to prevent duplicate events on longer streaks
    if (streak !== 9) return [];

    return [
      {
        type: 'lostrick_9',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          streak: 9,
        },
      },
    ];
  },
};
