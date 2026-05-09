/**
 * derive.ts — Pure function to map raw Henrik /v3/matches response into a
 * compact MatchRecordInsert suitable for storage in match_records.
 */

import type { HenrikMatch } from '../lib/henrik.ts';

// ─── Tier name table ──────────────────────────────────────────────────────────
// Maps numeric currenttier (0-27) to human-readable rank string.
// Source: Henrik API docs / Valorant rank tiers

const TIER_NAMES: Record<number, string> = {
  0: 'Unrated',
  1: 'Unknown',
  2: 'Unknown',
  3: 'Iron 1',
  4: 'Iron 2',
  5: 'Iron 3',
  6: 'Bronze 1',
  7: 'Bronze 2',
  8: 'Bronze 3',
  9: 'Silver 1',
  10: 'Silver 2',
  11: 'Silver 3',
  12: 'Gold 1',
  13: 'Gold 2',
  14: 'Gold 3',
  15: 'Platinum 1',
  16: 'Platinum 2',
  17: 'Platinum 3',
  18: 'Diamond 1',
  19: 'Diamond 2',
  20: 'Diamond 3',
  21: 'Ascendant 1',
  22: 'Ascendant 2',
  23: 'Ascendant 3',
  24: 'Immortal 1',
  25: 'Immortal 2',
  26: 'Immortal 3',
  27: 'Radiant',
};

function tierToName(tier: number): string {
  return TIER_NAMES[tier] ?? `Tier ${tier}`;
}

/** Average enemy team tier, rounded to nearest integer, mapped to tier name. */
function calcEnemyAvgRank(rawMatch: HenrikMatch, playerTeam: string): string | null {
  const enemyTeam = playerTeam.toLowerCase() === 'red' ? 'Blue' : 'Red';
  const enemies = rawMatch.players.all_players.filter(
    (p) => p.team === enemyTeam,
  );
  if (enemies.length === 0) return null;

  const tiersWithRank = enemies
    .map((p) => p.currenttier)
    .filter((t): t is number => typeof t === 'number' && t >= 3); // 0-2 = unrated/unknown, skip

  if (tiersWithRank.length === 0) return null;

  const avg = tiersWithRank.reduce((a, b) => a + b, 0) / tiersWithRank.length;
  const rounded = Math.round(avg);
  return tierToName(rounded);
}

// ─── MatchRecordInsert type ───────────────────────────────────────────────────

export interface MatchRecordInsert {
  riot_puuid: string;
  match_id: string;
  started_at: number;
  map: string;
  agent: string;
  kills: number;
  deaths: number;
  assists: number;
  result: 'win' | 'loss' | 'draw';
  rounds_played: number;
  rank_before: string | null;
  rank_after: string | null;
  enemy_avg_rank: string | null;
  fall_damage_kills: number;
  kill_events_compact: string;
}

// ─── Main derive function ─────────────────────────────────────────────────────

/**
 * Derive a compact MatchRecordInsert from a raw Henrik match response.
 *
 * Returns null if the match is not a competitive match (PRD: ranked only).
 */
export function deriveMatchRecord(rawMatch: HenrikMatch, puuid: string): MatchRecordInsert | null {
  // Only process competitive matches
  if (rawMatch.metadata.mode.toLowerCase() !== 'competitive') {
    return null;
  }

  // Find the target player
  const player = rawMatch.players.all_players.find((p) => p.puuid === puuid);
  if (!player) return null;

  const playerTeam = player.team; // 'Red' | 'Blue'

  // Determine result
  const redTeam = rawMatch.teams.red;
  const blueTeam = rawMatch.teams.blue;

  let result: 'win' | 'loss' | 'draw';
  const playerIsRed = playerTeam.toLowerCase() === 'red';
  const myTeam = playerIsRed ? redTeam : blueTeam;
  const enemyTeam = playerIsRed ? blueTeam : redTeam;

  if (myTeam?.has_won) {
    result = 'win';
  } else if (enemyTeam?.has_won) {
    result = 'loss';
  } else {
    // Both teams have has_won === false → check if rounds are tied (draw)
    // or just default to draw if we can't determine
    const myRoundsWon = myTeam?.rounds_won ?? 0;
    const enemyRoundsWon = enemyTeam?.rounds_won ?? 0;
    if (myRoundsWon === enemyRoundsWon) {
      result = 'draw';
    } else {
      result = myRoundsWon > enemyRoundsWon ? 'win' : 'loss';
    }
  }

  // Fall damage kills: deaths of our player caused by fall damage.
  // Using damage_type === 'Fall' as primary check (Henrik API field),
  // falling back to damage_weapon_id === 'Fall' if damage_type is absent.
  const fallDamageKills = rawMatch.kills.filter((k) => {
    if (k.victim_puuid !== puuid) return false;
    // Primary: damage_type field
    if (k.damage_type !== undefined) return k.damage_type === 'Fall';
    // Fallback: weapon_id
    return k.damage_weapon_id === 'Fall';
  }).length;

  // kill_events_compact: all kill events in the match (for event detection)
  const killEventsCompact = JSON.stringify(
    rawMatch.kills.map((k) => ({
      round: k.round,
      attacker_team: k.killer_team,
      victim_team: k.victim_team,
      weapon: k.damage_weapon_id,
      attacker_puuid: k.killer_puuid,
      victim_puuid: k.victim_puuid,
    })),
  );

  // rounds_played: from metadata or count of rounds array
  const roundsPlayed =
    rawMatch.metadata.rounds_played ??
    (Array.isArray(rawMatch.rounds) ? rawMatch.rounds.length : 0);

  return {
    riot_puuid: puuid,
    match_id: rawMatch.metadata.matchid,
    started_at: rawMatch.metadata.game_start * 1000,
    map: rawMatch.metadata.map,
    agent: player.character,
    kills: player.stats?.kills ?? 0,
    deaths: player.stats?.deaths ?? 0,
    assists: player.stats?.assists ?? 0,
    result,
    rounds_played: roundsPlayed,
    // rank_before is not available from Henrik v3/matches; using null
    // rank_after is the player's currenttier_patched at the time of the match
    rank_before: null,
    rank_after: player.currenttier_patched ?? null,
    enemy_avg_rank: calcEnemyAvgRank(rawMatch, playerTeam),
    fall_damage_kills: fallDamageKills,
    kill_events_compact: killEventsCompact,
  };
}
