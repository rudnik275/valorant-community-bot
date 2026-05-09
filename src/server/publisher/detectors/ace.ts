import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

export interface AceRound {
  round: number;
  weapons: string[];
}

/**
 * Finds all rounds where the player made ≥5 kills (an ace).
 * Exported for reuse by ace_rare_weapon detector.
 */
export function findAces(record: MatchRecord): AceRound[] {
  const kills = parseKillEvents(record);
  const byRound = new Map<number, typeof kills>();

  for (const k of kills) {
    if (k.attacker_puuid !== record.riot_puuid) continue;
    if (!byRound.has(k.round)) byRound.set(k.round, []);
    byRound.get(k.round)!.push(k);
  }

  const aces: AceRound[] = [];
  for (const [round, list] of byRound) {
    if (list.length >= 5) {
      aces.push({ round, weapons: list.map((k) => k.weapon) });
    }
  }
  return aces;
}

function parseKillEvents(record: MatchRecord): KillEvent[] {
  try {
    return JSON.parse(record.kill_events_compact) as KillEvent[];
  } catch {
    return [];
  }
}

interface KillEvent {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
}

/**
 * Ace detector: 5+ kills in a single round by the player.
 *
 * If multiple aces occur in the same match (rare but theoretically possible),
 * we emit ONE event with `rounds` array to avoid UNIQUE constraint conflict on
 * (match_id, event_type, riot_puuid).
 */
export const aceDetector: Detector = {
  type: 'ace',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    const aces = findAces(record);
    if (aces.length === 0) return [];

    return [
      {
        type: 'ace',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          rounds: aces.map((a) => a.round),
          weapons_per_round: aces.map((a) => a.weapons),
          total_aces: aces.length,
        },
      },
    ];
  },
};
