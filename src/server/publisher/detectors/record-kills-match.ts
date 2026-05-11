import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';

export const recordKillsMatchDetector: Detector = {
  type: 'record_kills_match',
  detect: () => [],  // not used — async path only
  detectAsync: async (record: MatchRecord, _prev: MatchRecord[], deps: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid) return [];
    const result = await upsertRecord(deps.db, {
      recordType: 'kills_match',
      value: record.kills,
      riotPuuid: record.riot_puuid,
      matchId: record.match_id,
      achievedAt: record.started_at,
    });
    if (!result.beaten) return [];
    return [
      {
        type: 'record_kills_match',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value: record.kills,
          prev_value: result.prev?.value ?? null,
          prev_puuid: result.prev?.puuid ?? null,
        },
      },
    ];
  },
};
