import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { getUserNameTag } from '../../db/queries.ts';

export const recordDamageReceivedMatchDetector: Detector = {
  type: 'record_damage_received_match',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid) return [];
    if (record.damage_received == null) return [];
    const result = await upsertRecord(deps!.db, {
      recordType: 'damage_received_match',
      value: record.damage_received,
      riotPuuid: record.riot_puuid,
      matchId: record.match_id,
      achievedAt: record.started_at,
    });
    if (!result.beaten) return [];

    let prevName = '', prevTag = '';
    if (result.prev) {
      ({ name: prevName, tag: prevTag } = await getUserNameTag(deps!.db, result.prev.puuid));
    }

    return [
      {
        type: 'record_damage_received_match',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value: record.damage_received,
          prev_value: result.prev?.value ?? null,
          prev_puuid: result.prev?.puuid ?? null,
          prev_name: prevName,
          prev_tag: prevTag,
        },
      },
    ];
  },
};
