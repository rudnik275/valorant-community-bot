import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';
import { decodeKillEvents, decodePerRoundAfk, decodeRounds } from '../../lib/match-codec.ts';

// Henrik may return weapon.name='Knife' or its canonical ID.
const KNIFE_TOKENS = new Set([
  'Knife',
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7',
]);

function isKnife(weapon: string): boolean {
  return KNIFE_TOKENS.has(weapon);
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
  async detect(record: MatchRecord, _prev: MatchRecord[]): Promise<DetectedEvent[]> {
    const puuid = record.riot_puuid ?? '';
    if (!puuid) return [];
    const kills = decodeKillEvents(record.kill_events_compact);
    const myKnifeKills = kills.filter(
      (k) => k.attacker_puuid === puuid && isKnife(k.weapon),
    );
    if (myKnifeKills.length === 0) return [];

    const rounds = myKnifeKills.map((k) => k.round);
    const playerTeam = kills.find((k) => k.attacker_puuid === puuid)?.attacker_team ?? '';
    const winnerByRound = new Map<number, string>();
    for (const r of decodeRounds(record.rounds_compact)) {
      if (r.w) winnerByRound.set(r.r, r.w);
    }
    const roundsWon = playerTeam
      ? [...new Set(rounds)].filter((r) => winnerByRound.get(r) === playerTeam)
      : [];

    // Per-kill AFK flag — parallel to `rounds`, looked up from the
    // per-round AFK map persisted on `match_records.per_round_afk_compact`.
    // Empty / null map (legacy match without this field) ⇒ all `false`,
    // which renders the same as before — fully backward compatible.
    const afkMap = decodePerRoundAfk(record.per_round_afk_compact);
    const victimsAfk = myKnifeKills.map(
      (k) => afkMap.get(k.round)?.has(k.victim_puuid) === true,
    );

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
          /**
           * Parallel to `rounds`: `true` if Riot flagged that kill's victim
           * `was_afk` in that round. Renderer collapses dupes via OR per
           * round → "распотрошил гуся" instead of "заколол баранчика".
           */
          victims_afk: victimsAfk,
        },
      },
    ];
  },
};
