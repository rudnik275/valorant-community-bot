/**
 * derive.ts — Pure function to map raw Henrik /v4/matches response into a
 * compact MatchRecordInsert suitable for storage in match_records.
 */

import type { HenrikMatchV4 } from '../lib/henrik.ts';

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

// ─── kill_events_compact entry ────────────────────────────────────────────────
// Shape expected by clutch.ts, ace.ts, teamkill.ts, ace-rare-weapon.ts

interface KillEventCompact {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
}

// ─── enemy_avg_rank helpers ───────────────────────────────────────────────────

/** Average enemy team tier, rounded to nearest integer, mapped to tier name. */
function calcEnemyAvgRank(match: HenrikMatchV4, playerTeamId: string): string | null {
  const opponents = match.players.filter(
    (p) => p.team_id !== undefined && p.team_id !== playerTeamId,
  );
  if (opponents.length === 0) return null;

  // Only consider players with a real rank (tier.id >= 3; 0-2 = unrated/unknown)
  const rankedTiers = opponents
    .map((p) => p.tier?.id)
    .filter((id): id is number => typeof id === 'number' && id >= 3);

  if (rankedTiers.length === 0) return null;

  const avg = rankedTiers.reduce((a, b) => a + b, 0) / rankedTiers.length;
  const rounded = Math.round(avg);

  // Find a player whose tier.id is closest to rounded — use their tier.name
  const match_ = opponents.find((p) => p.tier?.id === rounded);
  if (match_ && match_.tier?.name) return match_.tier.name;

  // If no exact match, find nearest and use their name, or build a generic label
  let best: typeof opponents[0] | null = null;
  let bestDiff = Infinity;
  for (const p of opponents) {
    if (p.tier?.id === undefined) continue;
    const diff = Math.abs(p.tier.id - rounded);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best?.tier?.name ?? null;
}

// ─── Main derive function ─────────────────────────────────────────────────────

/**
 * Derive a compact MatchRecordInsert from a raw Henrik v4 match response.
 *
 * Returns null if the matching player is not found in the match.
 * Callers are responsible for pre-filtering by queue.id before calling this.
 */
export function deriveMatchRecord(match: HenrikMatchV4, puuid: string): MatchRecordInsert | null {
  // Find the target player
  const player = match.players.find((p) => p.puuid === puuid);
  if (!player) return null;

  const playerTeamId = player.team_id ?? '';

  // Determine result
  const playerTeam = match.teams.find((t) => t.team_id === playerTeamId);
  const opponentTeam = match.teams.find((t) => t.team_id !== playerTeamId);

  let result: 'win' | 'loss' | 'draw';
  if (playerTeam?.won === true) {
    result = 'win';
  } else if (opponentTeam?.won === true) {
    result = 'loss';
  } else {
    // Neither team's `won` flag is true — check for a draw by comparing round counts
    const myWon = playerTeam?.rounds?.won ?? 0;
    const myLost = playerTeam?.rounds?.lost ?? 0;
    const oppWon = opponentTeam?.rounds?.won ?? 0;
    const oppLost = opponentTeam?.rounds?.lost ?? 0;
    if (myWon === oppLost && myLost === oppWon && myWon === myLost) {
      result = 'draw';
    } else {
      result = myWon > myLost ? 'win' : 'loss';
    }
  }

  // rounds_played: sum of won + lost for the first available team (both teams play same # rounds)
  const teamForRounds = match.teams[0];
  const roundsPlayed = teamForRounds
    ? (teamForRounds.rounds?.won ?? 0) + (teamForRounds.rounds?.lost ?? 0)
    : 0;

  // fall_damage_kills: count kill events where victim is our player AND weapon indicates fall.
  // In Henrik v4, fall damage appears as weapon.id === 'Fall' (same marker as v3 damage_weapon_id).
  // TODO Slice B #53: identify fall-damage marker in Henrik v4 — fixture inspection needed.
  // Using weapon.id === 'Fall' as best-effort; may also appear in weapon.name.
  const fallDamageKills = match.kills.filter((k) => {
    if (k.victim?.puuid !== puuid) return false;
    return k.weapon?.id === 'Fall' || k.weapon?.name === 'Fall';
  }).length;

  // kill_events_compact: compact array consumed by clutch, ace, teamkill detectors.
  // Shape: [{round, attacker_team, victim_team, weapon, attacker_puuid, victim_puuid}]
  const killEventsCompact: KillEventCompact[] = match.kills.map((k) => ({
    round: k.round ?? 0,
    attacker_team: k.killer?.team ?? '',
    victim_team: k.victim?.team ?? '',
    weapon: k.weapon?.name ?? k.weapon?.id ?? '',
    attacker_puuid: k.killer?.puuid ?? '',
    victim_puuid: k.victim?.puuid ?? '',
  }));

  return {
    riot_puuid: puuid,
    match_id: match.metadata.match_id,
    started_at: match.metadata.started_at ? Date.parse(match.metadata.started_at) : 0,
    map: match.metadata.map?.name ?? '',
    agent: player.agent?.name ?? '',
    kills: player.stats?.kills ?? 0,
    deaths: player.stats?.deaths ?? 0,
    assists: player.stats?.assists ?? 0,
    result,
    rounds_played: roundsPlayed,
    rank_before: null,
    rank_after: player.tier?.name ?? null,
    enemy_avg_rank: calcEnemyAvgRank(match, playerTeamId),
    fall_damage_kills: fallDamageKills,
    kill_events_compact: JSON.stringify(killEventsCompact),
  };
}
