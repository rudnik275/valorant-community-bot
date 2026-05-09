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
 * Teamkill detector: player killed a teammate (same team, different player).
 *
 * Excludes self-kills (attacker_puuid === victim_puuid) — those are suicides.
 * Emits ONE event per match with all affected rounds listed in payload.
 */
export const teamkillDetector: Detector = {
  type: 'teamkill',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    const puuid = record.riot_puuid ?? '';
    const kills = parseKillEvents(record);

    const teamkillRounds = kills
      .filter(
        (k) =>
          k.attacker_puuid === puuid &&
          k.attacker_team === k.victim_team &&
          k.victim_puuid !== puuid, // exclude self-kills
      )
      .map((k) => k.round);

    if (teamkillRounds.length === 0) return [];

    return [
      {
        type: 'teamkill',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          round_numbers: teamkillRounds,
        },
      },
    ];
  },
};
