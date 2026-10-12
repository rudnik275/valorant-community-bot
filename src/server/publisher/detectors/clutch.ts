import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';
import { decodeRounds } from '../../lib/match-codec.ts';

/** Henrik `rounds[].ceremony` value Riot plays for a clutch. */
const CLUTCH_CEREMONY = 'CeremonyClutch';

/**
 * Clutch detector: Riot played the clutch ceremony for THIS player.
 *
 * Source is Riot itself — `rounds_compact[].c === 'CeremonyClutch'` with
 * `rounds_compact[].cp` (Henrik v4.10 `rounds[].ceremony_player.puuid`) equal
 * to the record's player. No kill-timing heuristic (the old `clutch_1vN` was
 * dropped in #167); Riot names the clutcher, so there is nothing to get wrong.
 *
 * The 1vN size is NOT available — the match payload only says *that* the round
 * was a clutch — so nothing is reconstructed from kills (#385).
 *
 * Emits ONE event per match with the count and list of clutch rounds, like
 * `knife_kill`. A clutch round is always won by the clutcher, so `rounds_won`
 * equals `rounds` (kept for payload parity with ace / knife events).
 *
 * Rows scanned before #389 carry no `cp`, so they never produce a clutch —
 * there is no backfill.
 */
export const clutchDetector: Detector = {
  type: 'clutch',
  async detect(record: MatchRecord, _prev: MatchRecord[]): Promise<DetectedEvent[]> {
    const puuid = record.riot_puuid ?? '';
    if (!puuid) return [];
    const rounds = decodeRounds(record.rounds_compact)
      .filter((r) => r.c === CLUTCH_CEREMONY && r.cp === puuid)
      .map((r) => r.r);
    if (rounds.length === 0) return [];

    return [
      {
        type: 'clutch',
        riot_puuid: puuid,
        match_id: record.match_id,
        payload: {
          count: rounds.length,
          rounds,
          /** Same as `rounds` — Riot only awards the clutch ceremony to a won round. */
          rounds_won: [...rounds],
        },
      },
    ];
  },
};
