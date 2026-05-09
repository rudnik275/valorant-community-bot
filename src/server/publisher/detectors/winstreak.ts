import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

/**
 * Winstreak detector: fires exactly when the player reaches a 9-win streak.
 *
 * Counts consecutive wins in [record, ...prevRecords] sorted desc by started_at.
 * Emits ONLY when streak === 9 (not on 10, 11, etc.) to avoid duplicate events.
 * Draw or loss breaks the streak.
 */
export const winstreakDetector: Detector = {
  type: 'winstreak_9',
  detect(record: MatchRecord, prevRecords: MatchRecord[]): DetectedEvent[] {
    const allRecords = [record, ...prevRecords].sort(
      (a, b) => b.started_at - a.started_at,
    );

    let streak = 0;
    let oldestMatchId: string | null = null;

    for (const r of allRecords) {
      if (r.result === 'win') {
        streak++;
        oldestMatchId = r.match_id;
      } else {
        break;
      }
    }

    // Emit only at the exact threshold of 9 to prevent duplicate events on longer streaks
    if (streak !== 9) return [];

    return [
      {
        type: 'winstreak_9',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          streak: 9,
          started_match_id: oldestMatchId,
        },
      },
    ];
  },
};
