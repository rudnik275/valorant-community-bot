import type { Detector, DetectedEvent, MatchRecord, DetectorDeps } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { users } from '../../db/schema/users.ts';
import { matchRosters } from '../../db/schema/match_rosters.ts';
import { eq } from 'drizzle-orm';

export const recordLongestMatchMinutesDetector: Detector = {
  type: 'record_longest_match_minutes',
  detect: () => [],  // not used — async path only
  detectAsync: async (record: MatchRecord, _prev: MatchRecord[], deps: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.riot_puuid || !record.game_length_ms || record.game_length_ms <= 0) return [];
    const minutes = Math.round(record.game_length_ms / 60000);
    if (minutes <= 0) return [];

    const result = await upsertRecord(deps.db, {
      recordType: 'longest_match_minutes',
      value: minutes,
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
        type: 'record_longest_match_minutes',
        riot_puuid: record.riot_puuid,
        match_id: record.match_id,
        payload: {
          value: minutes,
          // Total rounds played in this match — rendered next to minutes in
          // the template (e.g. "58 минут (30 раундов)"). The triggering
          // player's `rounds_played` equals the match length, so we just
          // pass it through.
          rounds: record.rounds_played,
          // Match result from the triggering player's perspective. Friend
          // groups usually queue together so this is representative; if the
          // community split across both teams it just reflects whichever
          // puuid first broke the record.
          result: record.result,
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
