import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

export interface AceRound {
  round: number;
  weapons: string[];
  /** True iff the player's team won this round. */
  won: boolean;
  /** Victims killed in this ace round, in kill order, deduped by puuid. */
  victims: Array<{ puuid: string; name: string; tag: string }>;
}

interface RoundsCompactEntry {
  r: number;
  w?: string;
  c?: string;
}

function parseRoundsCompact(record: MatchRecord): RoundsCompactEntry[] {
  if (!record.rounds_compact) return [];
  try {
    return JSON.parse(record.rounds_compact) as RoundsCompactEntry[];
  } catch {
    return [];
  }
}

/**
 * Finds rounds where the player aced.
 *
 * Definition (this bot, NOT Riot): ≥5 kills by the player against enemies
 * (non-self, non-teammate) in a single round. Revived-enemy re-kills count.
 * See ADR 0003.
 */
export function findAces(record: MatchRecord): AceRound[] {
  const kills = parseKillEvents(record);

  // Bucket player's enemy kills per round (no dedup at threshold stage).
  const byRound = new Map<number, KillEvent[]>();
  for (const k of kills) {
    if (k.attacker_puuid !== record.riot_puuid) continue;
    if (k.victim_puuid === k.attacker_puuid) continue; // self-kill (spike suicide)
    if (k.attacker_team && k.victim_team && k.attacker_team === k.victim_team) continue;
    if (!byRound.has(k.round)) byRound.set(k.round, []);
    byRound.get(k.round)!.push(k);
  }

  // Player's team — derived from any of their kill events.
  const playerTeam = kills.find((k) => k.attacker_puuid === record.riot_puuid)?.attacker_team ?? '';

  // Map round → winning team for outcome flag.
  const roundWinner = new Map<number, string>();
  for (const r of parseRoundsCompact(record)) {
    if (r.w) roundWinner.set(r.r, r.w);
  }

  const aces: AceRound[] = [];
  for (const [round, list] of byRound) {
    if (list.length < 5) continue;

    // Dedup victims by puuid in kill order — used for display/opponent-peak.
    const seenVictims = new Set<string>();
    const victims: Array<{ puuid: string; name: string; tag: string }> = [];
    for (const k of list) {
      if (seenVictims.has(k.victim_puuid)) continue;
      seenVictims.add(k.victim_puuid);
      victims.push({
        puuid: k.victim_puuid,
        name: k.victim_name ?? '',
        tag: k.victim_tag ?? '',
      });
    }

    const winner = roundWinner.get(round);
    const won = playerTeam !== '' && winner !== undefined && winner === playerTeam;

    aces.push({
      round,
      weapons: list.map((k) => k.weapon),
      won,
      victims,
    });
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
 * Ace detector: ≥5 enemy kills in a single round by the player.
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
          /** Subset of `rounds`: round IDs where the player's team won the round. */
          rounds_won: aces.filter((a) => a.won).map((a) => a.round),
          weapons_per_round: aces.map((a) => a.weapons),
          total_aces: aces.length,
          /** All unique victims killed across all ace rounds. Used for opponent peak lookup. */
          victims: allVictims,
          /** Display names in kill order (deduped). Kept for back-compat with augmenter/templates. */
          victim_names_for_template: allVictims.map((v) => v.name),
        },
      },
    ];
  },
};
