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

    // Team round scores, keyed by team_id — needed for the rich full-roster
    // table's "победа X:Y" winner line (#315). The current player's row carries
    // their own team's (won, lost); the OTHER team's score is the mirror image
    // (its won == our lost, its lost == our won). Only derivable when this
    // player's team is known and both round counts are present; otherwise
    // omitted (rich renderer then falls back to legacy text).
    let teamScores: Record<string, { won: number; lost: number }> | undefined;
    if (
      currentPlayerTeam &&
      typeof record.team_rounds_won === 'number' &&
      typeof record.team_rounds_lost === 'number'
    ) {
      const otherTeam = Array.from(byTeam.keys()).find((t) => t !== currentPlayerTeam);
      teamScores = {
        [currentPlayerTeam]: { won: record.team_rounds_won, lost: record.team_rounds_lost },
      };
      if (otherTeam) {
        teamScores[otherTeam] = { won: record.team_rounds_lost, lost: record.team_rounds_won };
      }
    }

    return [{
      type: 'community_clash',
      riot_puuid: record.riot_puuid ?? '',
      match_id: record.match_id,
      payload: {
        teams: teamsArr,
        winner_team_id: winnerTeam,
        ...(teamScores ? { team_scores: teamScores } : {}),
      },
    }];
  },
};
