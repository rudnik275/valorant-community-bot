import type { Detector, DetectedEvent, DetectorDeps, MatchRecord } from '../types.ts';
import { decodeKillEvents } from '../../lib/match-codec.ts';
import { getUsersByPuuids } from '../../db/queries.ts';

/**
 * Teamkill detector: player killed a community teammate (same team, different player,
 * AND victim must be in the users table).
 *
 * Excludes self-kills (attacker_puuid === victim_puuid) — those are suicides.
 * Emits ONE event per match with all affected rounds + victim names listed in payload.
 */
export const teamkillDetector: Detector = {
  type: 'teamkill',
  detect: async (record: MatchRecord, _prev: MatchRecord[], deps?: DetectorDeps): Promise<DetectedEvent[]> => {
    const { db } = deps!; // orchestrator always supplies deps for DB-backed detectors
    const puuid = record.riot_puuid ?? '';
    if (!puuid) return [];

    const kills = decodeKillEvents(record.kill_events_compact);

    // Filter: attacker is this community player, same team, victim ≠ self
    const myTeamkills = kills.filter(
      (k) => k.attacker_puuid === puuid && k.attacker_team === k.victim_team && k.victim_puuid !== puuid,
    );
    if (myTeamkills.length === 0) return [];

    // Filter further: victim must be in users table (community member)
    const victimPuuids = Array.from(new Set(myTeamkills.map((k) => k.victim_puuid)));
    const communityVictims = await getUsersByPuuids(db, victimPuuids);

    if (communityVictims.length === 0) return [];

    const communitySet = new Set(communityVictims.map((u) => u.riot_puuid));
    const communityNames = new Map<string, { name: string; tag: string }>(
      communityVictims.map((u) =>
        [u.riot_puuid ?? '', { name: u.riot_name ?? '', tag: u.riot_tag ?? '' }]
      ),
    );

    const communityKills = myTeamkills.filter((k) => communitySet.has(k.victim_puuid));
    if (communityKills.length === 0) return [];

    return [{
      type: 'teamkill',
      riot_puuid: puuid,
      match_id: record.match_id,
      payload: {
        round_numbers: communityKills.map((k) => k.round),
        victims: communityKills.map((k) => ({
          puuid: k.victim_puuid,
          name: communityNames.get(k.victim_puuid)?.name ?? '',
          tag: communityNames.get(k.victim_puuid)?.tag ?? '',
        })),
        victim_names_for_template: communityKills.map((k) => communityNames.get(k.victim_puuid)?.name ?? ''),
      },
    }];
  },
};
