import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { hasEventSince } from '../../db/queries.ts';

/**
 * Returns the timestamp (ms) of Monday 00:00 UTC of the ISO week containing `ms`.
 * ISO week starts on Monday.
 */
function startOfIsoWeekMs(ms: number): number {
  const d = new Date(ms);
  // getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat
  // Days since Monday: (0+6)%7=6 for Sun, 0 for Mon, 1 for Tue, ...
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const mondayMs = ms - daysSinceMonday * 86_400_000
    - d.getUTCHours() * 3_600_000
    - d.getUTCMinutes() * 60_000
    - d.getUTCSeconds() * 1_000
    - d.getUTCMilliseconds();
  return mondayMs;
}

/**
 * Winstreak detector: fires when the player reaches a 10+ win streak.
 *
 * Counts consecutive wins in [record, ...prevRecords] sorted desc by started_at.
 * Emits when streak >= 10. Weekly dedup via detected_events table prevents
 * repeat emissions within the same ISO week for the same puuid.
 * Draw or loss breaks the streak.
 */
export const winstreakDetector: Detector = {
  type: 'winstreak_10plus',

  async detect(record: MatchRecord, prevRecords: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> {
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

    if (streak < 10) return [];

    // Weekly dedup: check if this puuid already had a winstreak_10plus event this week
    const weekStartMs = startOfIsoWeekMs(record.started_at);
    const alreadyEmitted = await hasEventSince(
      deps!.db,
      'winstreak_10plus',
      record.riot_puuid ?? '',
      weekStartMs,
    );
    if (alreadyEmitted) return [];

    return [
      {
        type: 'winstreak_10plus',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          streak,
          started_match_id: oldestMatchId,
        },
      },
    ];
  },
};
