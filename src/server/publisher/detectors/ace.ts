import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

export interface AceRound {
  round: number;
  weapons: string[];
  /** Victims killed in this ace round, in kill order. */
  victims: Array<{ puuid: string; name: string; tag: string }>;
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
      aces.push({
        round,
        weapons: list.map((k) => k.weapon),
        victims: list.map((k) => ({
          puuid: k.victim_puuid,
          name: k.victim_name ?? '',
          tag: k.victim_tag ?? '',
        })),
      });
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
  /** Optional — not present in v3 kill_events_compact; present in v4 when available. */
  victim_name?: string;
  victim_tag?: string;
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

    // Collect all unique victims across all ace rounds (de-duped by puuid, in kill order)
    const seenPuuids = new Set<string>();
    const allVictims: Array<{ puuid: string; name: string; tag: string }> = [];
    for (const ace of aces) {
      for (const v of ace.victims) {
        if (!seenPuuids.has(v.puuid)) {
          seenPuuids.add(v.puuid);
          allVictims.push(v);
        }
      }
    }

    return [
      {
        type: 'ace',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          rounds: aces.map((a) => a.round),
          weapons_per_round: aces.map((a) => a.weapons),
          total_aces: aces.length,
          /** All unique victims killed across all ace rounds. Used for opponent peak lookup. */
          victims: allVictims,
          /** Display names in kill order (empty string if unknown). Used by templates. */
          victim_names_for_template: allVictims.map((v) => v.name),
        },
      },
    ];
  },
};
