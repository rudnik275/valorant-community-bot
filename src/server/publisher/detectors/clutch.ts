import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

interface KillEvent {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
}

function parseKillEvents(record: MatchRecord): KillEvent[] {
  try {
    return JSON.parse(record.kill_events_compact) as KillEvent[];
  } catch {
    return [];
  }
}

/**
 * Clutch detector (heuristic for v1).
 *
 * True 1vN reconstruction requires round-by-round alive status which is not
 * stored in kill_events_compact. Heuristic used:
 *   - record.result === 'win' (player's team won the match overall)
 *   - In a given round, the player is the LAST killer (last kill event by index)
 *   - The player made ≥3 kills in that round
 *
 * This approximates clutch_1v3+. False positives exist (teammate may have
 * already killed enemies in that round), but intent is always a "clutch moment"
 * which is acceptable for this community context.
 */
export const clutchDetector: Detector = {
  type: 'clutch_1vN',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    if (record.result !== 'win') return [];

    const puuid = record.riot_puuid ?? '';
    const kills = parseKillEvents(record);

    // Group kills by round
    const byRound = new Map<number, KillEvent[]>();
    for (const k of kills) {
      if (!byRound.has(k.round)) byRound.set(k.round, []);
      byRound.get(k.round)!.push(k);
    }

    const clutchRounds: { round: number; kills: number }[] = [];

    for (const [round, roundKills] of byRound) {
      // Count how many kills the player made in this round
      const playerKills = roundKills.filter((k) => k.attacker_puuid === puuid);
      if (playerKills.length < 3) continue;

      // Check if the player made the last kill in the round
      const lastKill = roundKills[roundKills.length - 1];
      if (lastKill && lastKill.attacker_puuid === puuid) {
        clutchRounds.push({ round, kills: playerKills.length });
      }
    }

    if (clutchRounds.length === 0) return [];

    return [
      {
        type: 'clutch_1vN',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          rounds: clutchRounds,
        },
      },
    ];
  },
};
