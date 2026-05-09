import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

interface KillEvent {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
  /** Optional — not present in v3 kill_events_compact; present in v4 when available. */
  victim_name?: string;
  victim_tag?: string;
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
    const victimsByRound = new Map<number, Array<{ puuid: string; name: string; tag: string }>>();

    for (const [round, roundKills] of byRound) {
      // Count how many kills the player made in this round
      const playerKills = roundKills.filter((k) => k.attacker_puuid === puuid);
      if (playerKills.length < 3) continue;

      // Check if the player made the last kill in the round
      const lastKill = roundKills[roundKills.length - 1];
      if (lastKill && lastKill.attacker_puuid === puuid) {
        clutchRounds.push({ round, kills: playerKills.length });
        victimsByRound.set(
          round,
          playerKills.map((k) => ({
            puuid: k.victim_puuid,
            name: k.victim_name ?? '',
            tag: k.victim_tag ?? '',
          })),
        );
      }
    }

    if (clutchRounds.length === 0) return [];

    // Collect all unique victims across all clutch rounds (de-duped by puuid, in kill order)
    const seenPuuids = new Set<string>();
    const allVictims: Array<{ puuid: string; name: string; tag: string }> = [];
    for (const round of clutchRounds) {
      for (const v of victimsByRound.get(round.round) ?? []) {
        if (!seenPuuids.has(v.puuid)) {
          seenPuuids.add(v.puuid);
          allVictims.push(v);
        }
      }
    }

    return [
      {
        type: 'clutch_1vN',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          rounds: clutchRounds,
          /** All unique victims killed across all clutch rounds. Used for opponent peak lookup. */
          victims: allVictims,
          /** Display names in kill order (empty string if unknown). Used by templates. */
          victim_names_for_template: allVictims.map((v) => v.name),
        },
      },
    ];
  },
};
