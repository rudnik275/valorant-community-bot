import { eq, and } from 'drizzle-orm';
import type { Detector, DetectedEvent, DetectorDeps, MatchRecord } from '../types.ts';
import { matchRosters } from '../../db/schema/match_rosters.ts';
import { users } from '../../db/schema/users.ts';
import { detectedEvents } from '../../db/schema/detected_events.ts';

export const communityClashDetector: Detector = {
  type: 'community_clash',
  detect: () => [],  // not used — async path only
  detectAsync: async (record: MatchRecord, _prev: MatchRecord[], deps: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.match_id) return [];

    // Idempotency guard: if this match already has a community_clash event, skip
    const existing = await deps.db
      .select({ id: detectedEvents.id })
      .from(detectedEvents)
      .where(and(
        eq(detectedEvents.event_type, 'community_clash'),
        eq(detectedEvents.match_id, record.match_id),
      ))
      .limit(1);
    if (existing.length > 0) return [];

    // Query roster ⋈ users (only community members who are in this match)
    const rosters = await deps.db
      .select({
        riot_puuid: matchRosters.riot_puuid,
        team: matchRosters.team,
        riot_name: users.riot_name,
        riot_tag: users.riot_tag,
      })
      .from(matchRosters)
      .innerJoin(users, eq(users.riot_puuid, matchRosters.riot_puuid))
      .where(eq(matchRosters.match_id, record.match_id));

    if (rosters.length < 2) return [];

    // Group by team
    const byTeam = new Map<string, Array<{ puuid: string; name: string | null; tag: string | null }>>();
    for (const r of rosters) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team)!.push({ puuid: r.riot_puuid, name: r.riot_name, tag: r.riot_tag });
    }

    // Need at least 2 different teams with community members
    if (byTeam.size < 2) return [];

    // Determine winner team from the current player's perspective:
    //   - The current player is in record.riot_puuid; look up their team from the roster.
    //   - If record.result === 'win', their team won; if 'loss', the other team won; if 'draw', null.
    let currentPlayerTeam: string | null = null;
    for (const r of rosters) {
      if (r.riot_puuid === record.riot_puuid) {
        currentPlayerTeam = r.team;
        break;
      }
    }

    let winnerTeam: string | null = null;
    if (currentPlayerTeam) {
      if (record.result === 'win') {
        winnerTeam = currentPlayerTeam;
      } else if (record.result === 'loss') {
        // Winner is the other team — find any team_id != currentPlayerTeam
        for (const teamId of byTeam.keys()) {
          if (teamId !== currentPlayerTeam) {
            winnerTeam = teamId;
            break;
          }
        }
      }
      // draw → winnerTeam stays null → template renders 🏳️ tie
    }

    const teamsArr = Array.from(byTeam.entries()).map(([team_id, players]) => ({ team_id, players }));

    return [{
      type: 'community_clash',
      riot_puuid: record.riot_puuid ?? '',
      match_id: record.match_id,
      payload: {
        teams: teamsArr,
        winner_team_id: winnerTeam,
      },
    }];
  },
};
