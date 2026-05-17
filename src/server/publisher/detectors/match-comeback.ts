import type { Detector, DetectedEvent, DetectorDeps, MatchRecord } from '../types.ts';
import { decodeRounds } from '../../lib/match-codec.ts';
import { hasMatchEvent, getCommunityRoster } from '../../db/queries.ts';

const MIN_DEFICIT = 8;

export const matchComebackDetector: Detector = {
  type: 'match_comeback',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    if (record.result !== 'win') return [];
    if (!record.rounds_compact) return [];
    if (!record.match_id) return [];

    // Only rounds with a known winning team participate in comeback scoring.
    const rounds = decodeRounds(record.rounds_compact).filter(
      (r): r is { r: number; w: string; c?: string } => typeof r.w === 'string' && r.w !== '',
    );
    if (rounds.length === 0) return [];

    // Idempotency guard: skip if a match_comeback event already exists for this
    // match. Without this, every community winner's scan would emit a separate
    // event for the same match (spamming the chat with N copies of the same
    // "comeback" message).
    if (await hasMatchEvent(deps!.db, 'match_comeback', record.match_id)) return [];

    // Identify the player's team_id: it's the team whose round-win count equals
    // record.team_rounds_won. Bail out if no team matches (corrupt data).
    const winsByTeam = new Map<string, number>();
    for (const r of rounds) {
      winsByTeam.set(r.w, (winsByTeam.get(r.w) ?? 0) + 1);
    }
    let playerTeam: string | null = null;
    for (const [team, count] of winsByTeam) {
      if (count === record.team_rounds_won) {
        playerTeam = team;
        break;
      }
    }
    if (!playerTeam) return [];

    // Walk rounds in order. The displayed score is the point of MAX gap
    // (opponent - player). Where two points tie on gap, we keep the first —
    // i.e. the earlier point, with the smaller opponent score. The exit
    // criterion is max gap >= MIN_DEFICIT; matches that never crossed the
    // threshold are dropped.
    let playerScore = 0;
    let opponentScore = 0;
    let maxDeficit = 0;
    let displayedPoint = { player: 0, opponent: 0 };
    for (const r of rounds.slice().sort((a, b) => a.r - b.r)) {
      if (r.w === playerTeam) playerScore++;
      else opponentScore++;
      const deficit = opponentScore - playerScore;
      if (deficit > maxDeficit) {
        maxDeficit = deficit;
        displayedPoint = { player: playerScore, opponent: opponentScore };
      }
    }

    if (maxDeficit < MIN_DEFICIT) return [];

    // Collect community members on the winning team. The current record's puuid
    // is always one of them (it's the player whose scan triggered detection and
    // record.result === 'win'). When other community members are on the LOSING
    // team they aren't congratulated for the comeback — only winners go into
    // the payload list. Losing-side community members never reach this branch
    // anyway because their own record has result='loss' and bails out above.
    const rosterRows = await getCommunityRoster(deps!.db, record.match_id, playerTeam);

    const communityPlayers = rosterRows.map((r) => ({
      puuid: r.riot_puuid,
      name: r.riot_name ?? '',
      tag: r.riot_tag ?? '',
    }));

    return [{
      type: 'match_comeback',
      riot_puuid: record.riot_puuid ?? '',
      match_id: record.match_id,
      payload: {
        max_deficit: maxDeficit,
        deficit_score_player: displayedPoint.player,
        deficit_score_opponent: displayedPoint.opponent,
        final_score_player: playerScore,
        final_score_opponent: opponentScore,
        community_players: communityPlayers,
      },
    }];
  },
};
