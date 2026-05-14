import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

interface KillEvent {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
}

interface RoundsCompactEntry {
  r: number;
  w?: string;
  c?: string;
}

// Henrik may return weapon.name='Knife' or its canonical ID.
const KNIFE_TOKENS = new Set([
  'Knife',
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7',
]);

function isKnife(weapon: string): boolean {
  return KNIFE_TOKENS.has(weapon);
}

function parseKills(record: MatchRecord): KillEvent[] {
  try {
    return JSON.parse(record.kill_events_compact) as KillEvent[];
  } catch {
    return [];
  }
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
 * Knife kill detector: player killed ≥1 enemy with a knife.
 *
 * Emits ONE event per match with the count and list of rounds. UNIQUE
 * constraint on (match_id, event_type, riot_puuid) enforces one per match.
 * Per ADR 0003-style payload, also emits `rounds_won` (subset of `rounds`
 * where the player's team won that round) so the daily digest renderer
 * can show 🏆/💀 per knife kill, same shape as ace events.
 */
export const knifeKillDetector: Detector = {
  type: 'knife_kill',
  detect(record: MatchRecord, _prev: MatchRecord[]): DetectedEvent[] {
    const puuid = record.riot_puuid ?? '';
    if (!puuid) return [];
    const kills = parseKills(record);
    const myKnifeKills = kills.filter(
      (k) => k.attacker_puuid === puuid && isKnife(k.weapon),
    );
    if (myKnifeKills.length === 0) return [];

    const rounds = myKnifeKills.map((k) => k.round);
    const playerTeam = kills.find((k) => k.attacker_puuid === puuid)?.attacker_team ?? '';
    const winnerByRound = new Map<number, string>();
    for (const r of parseRoundsCompact(record)) {
      if (r.w) winnerByRound.set(r.r, r.w);
    }
    const roundsWon = playerTeam
      ? [...new Set(rounds)].filter((r) => winnerByRound.get(r) === playerTeam)
      : [];

    return [
      {
        type: 'knife_kill',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          count: myKnifeKills.length,
          rounds,
          /** Subset of `rounds` where the player's team won that round. */
          rounds_won: roundsWon,
        },
      },
    ];
  },
};
