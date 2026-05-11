import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

interface KillEvent {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
}

// Henrik may return weapon.name='Knife' or its canonical ID.
// Source-of-truth: ace-rare-weapon.ts uses 'Knife' string + '2f59173c-4bed-b6c3-2191-dea9b58be9c7' UUID.
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

/**
 * Knife kill detector: player killed ≥1 enemy with a knife.
 *
 * Emits ONE event per match with the count and list of rounds.
 * UNIQUE constraint on (match_id, event_type, riot_puuid) enforces one per match.
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
    return [
      {
        type: 'knife_kill',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          count: myKnifeKills.length,
          rounds: myKnifeKills.map((k) => k.round),
        },
      },
    ];
  },
};
