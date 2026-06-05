import type { Detector, DetectedEvent, DetectorDeps, MatchRecord } from '../types.ts';
import { hasMatchEvent, getCommunityRoster } from '../../db/queries.ts';

export const communityClashDetector: Detector = {
  type: 'community_clash',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    if (!record.match_id) return [];

    // Idempotency guard: if this match already has a community_clash event, skip
    if (await hasMatchEvent(deps!.db, 'community_clash', record.match_id)) return [];

    // Query roster ⋈ users (only community members who are in this match)
    const rosters = await getCommunityRoster(deps!.db, record.match_id);

    if (rosters.length < 2) return [];

    // Group by team
    const byTeam = new Map<string, Array<{ puuid: string; name: string | null; tag: string | null; agent: string | null }>>();
    for (const r of rosters) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team)!.push({ puuid: r.riot_puuid, name: r.riot_name, tag: r.riot_tag, agent: r.agent });
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
