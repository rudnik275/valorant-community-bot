import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';

export interface AceRound {
  round: number;
  weapons: string[];
  /** Victims killed in this ace round, in kill order. */
  victims: Array<{ puuid: string; name: string; tag: string }>;
}

interface RoundsCompactEntry {
  r: number;
  w?: string;
  /** Henrik's `rounds[].ceremony` verbatim. "CeremonyAce" is the ground-truth ace marker. */
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
 * Finds rounds where the player aced (killed all 5 enemies).
 *
 * Ground-truth signal: Henrik's `rounds[].ceremony === "CeremonyAce"`, plumbed
 * through `rounds_compact[].c`. This matches the in-game banner, which Valorant
 * fires ONLY when one player kills each unique enemy (no revived re-kills, no
 * self/teamkill counted) — so it sidesteps every agent-specific edge case
 * (Phoenix Run-It-Back, spike-suicide, etc.) that pure kill-count heuristics
 * would mis-handle.
 *
 * Backwards compat: for older `match_records` rows whose `rounds_compact` was
 * stored before the `c` field was added, no rounds carry `c` → no aces are
 * emitted from those rows. New scans (after this migration) populate `c`
 * correctly. We do not retroactively re-detect from kill counts because that
 * is exactly the heuristic the ceremony field replaces.
 */
export function findAces(record: MatchRecord): AceRound[] {
  const rounds = parseRoundsCompact(record);
  const aceRoundIds = new Set(
    rounds.filter((r) => r.c === 'CeremonyAce').map((r) => r.r),
  );
  if (aceRoundIds.size === 0) return [];

  // We still need to attribute the ace to OUR player (ceremony is per-round,
  // not per-player). The ace-getter killed all 5 enemies, so their kill_events
  // for that round will contain 5 unique non-self enemy victims. Collect them
  // so the payload (victims / weapons) reflects reality.
  const kills = parseKillEvents(record);
  const byRound = new Map<number, KillEvent[]>();
  for (const k of kills) {
    if (!aceRoundIds.has(k.round)) continue;
    if (k.attacker_puuid !== record.riot_puuid) continue;
    if (k.victim_puuid === k.attacker_puuid) continue; // self-kill (spike suicide)
    if (k.attacker_team && k.victim_team && k.attacker_team === k.victim_team) continue;
    if (!byRound.has(k.round)) byRound.set(k.round, []);
    byRound.get(k.round)!.push(k);
  }

  const aces: AceRound[] = [];
  for (const round of aceRoundIds) {
    const list = byRound.get(round) ?? [];
    // Dedupe by victim_puuid in kill order.
    const seenVictims = new Set<string>();
    const uniqueKills: KillEvent[] = [];
    for (const k of list) {
      if (seenVictims.has(k.victim_puuid)) continue;
      seenVictims.add(k.victim_puuid);
      uniqueKills.push(k);
    }
    // If our player has <5 unique enemy victims, the ace belongs to a
    // teammate, not us — don't emit. (Defensive: in normal play Valorant
    // requires exactly 5, but data-corruption / missing fields could
    // produce a stub.)
    if (uniqueKills.length < 5) continue;
    aces.push({
      round,
      weapons: uniqueKills.map((k) => k.weapon),
      victims: uniqueKills.map((k) => ({
        puuid: k.victim_puuid,
        name: k.victim_name ?? '',
        tag: k.victim_tag ?? '',
      })),
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
