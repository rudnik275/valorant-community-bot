import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { getUserNameTag } from '../../db/queries.ts';

export const recordSurvivedLastRoundsDetector: Detector = {
  type: 'record_survived_last_rounds',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid) return [];
    if (record.survived_last_rounds === null) return [];

    const result = await upsertRecord(deps!.db, {
      recordType: 'survived_last_rounds_match',
      value: record.survived_last_rounds,
      riotPuuid: record.riot_puuid,
      matchId: record.match_id,
      achievedAt: record.started_at,
    });
    if (!result.beaten) return [];

    let prevName = '';
    let prevTag = '';
    if (result.prev) {
      ({ name: prevName, tag: prevTag } = await getUserNameTag(deps!.db, result.prev.puuid));
    }

    return [
      {
        type: 'record_survived_last_rounds',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value: record.survived_last_rounds,
          prev_value: result.prev?.value ?? null,
          prev_puuid: result.prev?.puuid ?? null,
          prev_name: prevName,
          prev_tag: prevTag,
        },
      },
    ];
  },
};
