import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { getUserNameTag } from '../../db/queries.ts';

/**
 * 📊 Любимчик Riot — the best single-match Riot performance score
 * (`match_records.performance_score`, Henrik v4.10 `players[].performance.score`).
 *
 * The score is continuous (~180–355 on a real match); the record keeps it
 * rounded to a whole number, so a strict `>` beat means a visibly higher score
 * rather than 300.2 dethroning 300.1. Rows scanned before #384 carry no score
 * (null) and never compete.
 */
export const recordPerformanceScoreMatchDetector: Detector = {
  type: 'record_performance_score_match',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid) return [];
    if (record.performance_score == null || record.performance_score <= 0) return [];

    const value = Math.round(record.performance_score);
    const result = await upsertRecord(deps!.db, {
      recordType: 'performance_score_match',
      value,
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
        type: 'record_performance_score_match',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value,
          prev_value: result.prev?.value ?? null,
          prev_puuid: result.prev?.puuid ?? null,
          prev_name: prevName,
          prev_tag: prevTag,
        },
      },
    ];
  },
};
