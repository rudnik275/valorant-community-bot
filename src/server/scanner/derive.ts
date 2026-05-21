/**
 * derive.ts — Pure function to map raw Henrik /v4/matches response into a
 * compact MatchRecordInsert suitable for storage in match_records.
 */

import type { HenrikMatchV4 } from '../lib/henrik.ts';
import {
  encodeKillEvents,
  encodePerRoundAfk,
  encodeRounds,
  type KillEventCompact,
  type RoundCompact,
} from '../lib/match-codec.ts';

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
  rounds_compact: string;
  /**
   * Per-round AFK map encoded by {@link encodePerRoundAfk}. `null` when
   * Henrik's `rounds[].stats[]` is absent (legacy / unexpected response);
   * `"{}"` when present but no player was AFK in any round.
   */
  per_round_afk_compact: string | null;
  score: number | null;
  headshots: number | null;
  bodyshots: number | null;
  legshots: number | null;
  damage_dealt: number | null;
  damage_received: number | null;
  team_rounds_won: number | null;
  team_rounds_lost: number | null;
  game_length_ms: number | null;
  is_match_mvp: number | null;
  survived_last_rounds: number | null;
}

// kill_events_compact / rounds_compact shapes (KillEventCompact, RoundCompact)
// live in lib/match-codec.ts — the single source of truth for the compact
// match payload format. derive.ts encodes through that module; all consumer
// sites decode through it.

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

// ─── MatchRosterInsert type ───────────────────────────────────────────────────

export interface MatchRosterInsert {
  match_id: string;
  riot_puuid: string;
  team: string;
  name: string | null;
  tag: string | null;
}

/**
 * Derive roster rows for ALL players in a match (not puuid-specific).
 *
 * Returns one row per player (up to 10 in a standard 5v5 match).
 * Returns an empty array when metadata.match_id is missing.
 * Callers should insert with onConflictDoNothing() — same match scanned
 * for multiple community players dedupes correctly on PK (match_id, riot_puuid).
 */
export function deriveMatchRoster(match: HenrikMatchV4): MatchRosterInsert[] {
  const matchId = match.metadata?.match_id;
  if (!matchId) return [];
  return match.players
    .filter((p) => p.puuid && p.team_id)
    .map((p) => ({
      match_id: matchId,
      riot_puuid: p.puuid,
      team: p.team_id!,
      name: p.name ?? null,
      tag: p.tag ?? null,
    }));
}

// ─── survived_last_rounds helper ──────────────────────────────────────────────

/**
 * Count rounds where `puuid` died and was the LATEST teammate to die among
 * ≥2 same-team deaths in that round (max `time_in_round_in_ms`). Rounds with
 * <2 team-deaths or missing timings are excluded — solo deaths award nothing
 * (anti-tank), and we don't guess ordering when timings are absent.
 *
 * Returns `null` when no round qualifies — distinguishes "no signal" from
 * "never tanked = 0". Detector early-returns on `null`.
 *
 * Note: relies only on the WITHIN-round ordering of timings, so the open
 * question from #258 about whether `time_in_round_in_ms` starts at buy-phase
 * or barrier-drop is irrelevant — every player in the round shares the same
 * timeline.
 */
function calcSurvivedLastRounds(match: HenrikMatchV4, puuid: string, teamId: string): number | null {
  const byRound = new Map<number, Array<{ puuid: string; t: number }>>();
  for (const k of match.kills) {
    if (k.victim?.team !== teamId) continue;
    if (typeof k.time_in_round_in_ms !== 'number') continue;
    const victimPuuid = k.victim?.puuid;
    if (!victimPuuid) continue;
    const round = k.round ?? 0;
    let list = byRound.get(round);
    if (!list) { list = []; byRound.set(round, list); }
    list.push({ puuid: victimPuuid, t: k.time_in_round_in_ms });
  }

  let qualifyingRounds = 0;
  let count = 0;
  for (const deaths of byRound.values()) {
    if (deaths.length < 2) continue;
    qualifyingRounds++;
    let maxT = -Infinity;
    let maxPuuid: string | null = null;
    for (const d of deaths) {
      if (d.t > maxT) { maxT = d.t; maxPuuid = d.puuid; }
    }
    if (maxPuuid === puuid) count++;
  }

  return qualifyingRounds === 0 ? null : count;
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

  // is_match_mvp: 1 if this player's combat score is the max among all players in
  // the match, 0 otherwise. Null when our player has no score, or when no other
  // player in the match has a score (can't establish a max). Ties → all tied
  // players are flagged as MVP.
  const playerScore = player.stats?.score ?? null;
  const allScores = match.players
    .map((p) => p.stats?.score)
    .filter((s): s is number => typeof s === 'number');
  const isMatchMvp = playerScore != null && allScores.length > 0
    ? (playerScore >= Math.max(...allScores) ? 1 : 0)
    : null;

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

  // rounds_compact: compact round-level list consumed by match-comeback + ace detectors.
  // Shape: [{r: round_id, w: winning_team_id, c?: ceremony_string}]
  // `c` carries Henrik's `rounds[].ceremony` verbatim (e.g. "CeremonyAce") —
  // the ace detector treats `"CeremonyAce"` as ground truth.
  const roundsCompact: RoundCompact[] = match.rounds
    .filter((r) => r.winning_team)
    .map((r) => {
      const entry: RoundCompact = { r: r.id ?? 0, w: r.winning_team! };
      if (r.ceremony) entry.c = r.ceremony;
      return entry;
    });

  // per_round_afk_compact: { "<round>": ["puuid", ...] } of players Riot
  // flagged `was_afk` per round. `null` when `rounds[].stats[]` is absent
  // entirely (legacy/unexpected); `"{}"` when present but no AFK anywhere
  // (the normal case). Feeds the knife-kill detector to tag "распотрошил
  // гуся" vs "заколол баранчика" and is the source-of-truth for any
  // future AFK-related stat / record.
  let perRoundAfkRaw: string | null = null;
  if (Array.isArray(match.rounds)) {
    const afkMap = new Map<number, Set<string>>();
    let sawAnyStats = false;
    for (const r of match.rounds) {
      if (!Array.isArray(r.stats) || r.stats.length === 0) continue;
      sawAnyStats = true;
      const roundId = r.id ?? 0;
      for (const s of r.stats) {
        if (s?.was_afk !== true) continue;
        const p = s.player?.puuid;
        if (!p) continue;
        let set = afkMap.get(roundId);
        if (!set) { set = new Set(); afkMap.set(roundId, set); }
        set.add(p);
      }
    }
    if (sawAnyStats) perRoundAfkRaw = encodePerRoundAfk(afkMap);
  }

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
    kill_events_compact: encodeKillEvents(killEventsCompact),
    rounds_compact: encodeRounds(roundsCompact),
    per_round_afk_compact: perRoundAfkRaw,
    score: player.stats?.score ?? null,
    headshots: player.stats?.headshots ?? null,
    bodyshots: player.stats?.bodyshots ?? null,
    legshots: player.stats?.legshots ?? null,
    damage_dealt: player.stats?.damage?.dealt ?? null,
    damage_received: player.stats?.damage?.received ?? null,
    team_rounds_won: playerTeam?.rounds?.won ?? null,
    team_rounds_lost: playerTeam?.rounds?.lost ?? null,
    game_length_ms: match.metadata.game_length_in_ms ?? null,
    is_match_mvp: isMatchMvp,
    survived_last_rounds: calcSurvivedLastRounds(match, puuid, playerTeamId),
  };
}
