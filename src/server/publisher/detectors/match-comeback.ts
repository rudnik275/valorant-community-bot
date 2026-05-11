import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

interface RoundCompact { r: number; w: string; }

const MIN_DEFICIT = 8;

export const matchComebackDetector: Detector = {
  type: 'match_comeback',
  detect(record: MatchRecord, _prev: MatchRecord[]): DetectedEvent[] {
    if (record.result !== 'win') return [];
    if (!record.rounds_compact) return [];

    let rounds: RoundCompact[];
    try {
      rounds = JSON.parse(record.rounds_compact) as RoundCompact[];
    } catch { return []; }
    if (rounds.length === 0) return [];

    // Find the player's team_id. We know team_rounds_won is on record.
    // The player's team is whichever team won (record.result === 'win'). Among the rounds list,
    // the player's team is the one that has count === team_rounds_won.
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

    // Walk rounds in order, track running score. Find max deficit (opponent - player).
    let playerScore = 0;
    let opponentScore = 0;
    let maxDeficit = 0;
    let scoreAtMaxDeficit = { player: 0, opponent: 0 };
    for (const r of rounds.slice().sort((a, b) => a.r - b.r)) {
      if (r.w === playerTeam) playerScore++;
      else opponentScore++;
      const deficit = opponentScore - playerScore;
      if (deficit > maxDeficit) {
        maxDeficit = deficit;
        scoreAtMaxDeficit = { player: playerScore, opponent: opponentScore };
      }
    }

    if (maxDeficit < MIN_DEFICIT) return [];

    return [{
      type: 'match_comeback',
      riot_puuid: record.riot_puuid ?? '',
      match_id: record.match_id,
      payload: {
        max_deficit: maxDeficit,
        deficit_score_player: scoreAtMaxDeficit.player,
        deficit_score_opponent: scoreAtMaxDeficit.opponent,
        final_score_player: playerScore,
        final_score_opponent: opponentScore,
      },
    }];
  },
};
