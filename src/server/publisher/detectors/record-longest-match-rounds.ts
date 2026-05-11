import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { users } from '../../db/schema/users.ts';
import { matchRosters } from '../../db/schema/match_rosters.ts';
import { eq } from 'drizzle-orm';

export const recordLongestMatchRoundsDetector: Detector = {
  type: 'record_longest_match_rounds',
  detect: () => [],  // not used — async path only
  detectAsync: async (record: MatchRecord, _prev: MatchRecord[], deps: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid || record.rounds_played == null || record.rounds_played <= 0) return [];

    const result = await upsertRecord(deps.db, {
      recordType: 'longest_match_rounds',
      value: record.rounds_played,
      riotPuuid: record.riot_puuid,
      matchId: record.match_id,
      achievedAt: record.started_at,
    });
    if (!result.beaten) return [];

    let prevName = '', prevTag = '';
    if (result.prev) {
      const [u] = await deps.db
        .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
        .from(users)
        .where(eq(users.riot_puuid, result.prev.puuid))
        .limit(1);
      prevName = u?.riot_name ?? '';
      prevTag = u?.riot_tag ?? '';
    }

    // List all community players in this match (joined users table so we only get known players)
    const community = await deps.db
      .select({ riot_puuid: matchRosters.riot_puuid, riot_name: users.riot_name, riot_tag: users.riot_tag })
      .from(matchRosters)
      .innerJoin(users, eq(users.riot_puuid, matchRosters.riot_puuid))
      .where(eq(matchRosters.match_id, record.match_id));

    return [
      {
        type: 'record_longest_match_rounds',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value: record.rounds_played,
          prev_value: result.prev?.value ?? null,
          prev_puuid: result.prev?.puuid ?? null,
          prev_name: prevName,
          prev_tag: prevTag,
          community_players: community.map((c: { riot_puuid: string; riot_name: string | null; riot_tag: string | null }) => ({
            puuid: c.riot_puuid,
            name: c.riot_name ?? '',
            tag: c.riot_tag ?? '',
          })),
        },
      },
    ];
  },
};
