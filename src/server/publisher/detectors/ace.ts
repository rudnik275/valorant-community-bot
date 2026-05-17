import type { Detector, DetectedEvent, EnrichContext, MatchRecord } from '../types.ts';
import { decodeKillEvents, decodeRounds, type KillEventCompact } from '../../lib/match-codec.ts';
import logger from '../../lib/log.ts';

export interface AceRound {
  round: number;
  weapons: string[];
  /** True iff the player's team won this round. */
  won: boolean;
  /** Victims killed in this ace round, in kill order, deduped by puuid. */
  victims: Array<{ puuid: string; name: string; tag: string }>;
}

/**
 * Finds rounds where the player aced.
 *
 * Definition (this bot, NOT Riot): ≥5 kills by the player against enemies
 * (non-self, non-teammate) in a single round. Revived-enemy re-kills count.
 * See ADR 0003.
 */
export function findAces(record: MatchRecord): AceRound[] {
  const kills = decodeKillEvents(record.kill_events_compact);

  // Bucket player's enemy kills per round (no dedup at threshold stage).
  const byRound = new Map<number, KillEventCompact[]>();
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
  for (const r of decodeRounds(record.rounds_compact)) {
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

/**
 * Ace detector: ≥5 enemy kills in a single round by the player.
 *
 * If multiple aces occur in the same match (rare but theoretically possible),
 * we emit ONE event with `rounds` array to avoid UNIQUE constraint conflict on
 * (match_id, event_type, riot_puuid).
 */
export const aceDetector: Detector = {
  type: 'ace',
  async detect(record: MatchRecord, _prevRecords: MatchRecord[]): Promise<DetectedEvent[]> {
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

  /**
   * Opponent-peak enrichment (previously hard-coded in the orchestrator as
   * `if (ev.type === 'ace')` reaching into `payload.victims`). Behaviour is
   * byte-identical: collect unique victims across this detector's ace events,
   * fetch their peak ranks once, and merge the SAME complete `opponents_peak`
   * map into every ace event's payload. No region / no victims → events
   * returned unchanged.
   */
  async enrich(events: DetectedEvent[], ctx: EnrichContext): Promise<DetectedEvent[]> {
    if (events.length === 0) return events;

    if (!ctx.region) {
      logger.warn(
        { module: 'detect', puuid: ctx.riot_puuid, match_id: ctx.match_id },
        'No region found for player — skipping opponent peak augmentation',
      );
      return events;
    }

    // Collect all unique victims across ace events (kill order, deduped).
    const seenPuuids = new Set<string>();
    const allVictims: Array<{ puuid: string; name: string; tag: string }> = [];
    for (const ev of events) {
      const victims = ev.payload['victims'] as
        | Array<{ puuid: string; name: string; tag: string }>
        | undefined;
      if (Array.isArray(victims)) {
        for (const v of victims) {
          if (!seenPuuids.has(v.puuid)) {
            seenPuuids.add(v.puuid);
            allVictims.push(v);
          }
        }
      }
    }

    if (allVictims.length === 0) return events;

    const peakMap = await ctx.getOpponentPeakRanksFn(allVictims, ctx.region);

    for (const ev of events) {
      const opponents_peak: Record<
        string,
        { tier_id: number; tier_name: string; season_short: string }
      > = {};
      for (const [victimPuuid, peak] of peakMap) {
        opponents_peak[victimPuuid] = peak;
      }
      ev.payload = { ...ev.payload, opponents_peak };
    }

    return events;
  },
};
