import { describe, it, expect } from 'vitest';
import { matchComebackDetector } from './match-comeback.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-comeback-001',
  started_at: 1747000000000,
  map: 'Ascent',
  agent: 'Jett',
  kills: 20,
  deaths: 15,
  assists: 5,
  result: 'win',
  rounds_played: 24,
  rank_before: null,
  rank_after: 'Diamond 1',
  enemy_avg_rank: 'Diamond 1',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  rounds_compact: null,
  score: null,
  headshots: null,
  bodyshots: null,
  legshots: null,
  damage_dealt: null,
  damage_received: null,
  team_rounds_won: 13,
  team_rounds_lost: 11,
  game_length_ms: null,
  is_match_mvp: null,
  inserted_at: 1747000000000,
};

/**
 * Build rounds_compact JSON simulating a comeback match.
 *
 * blueWins: array of round ids won by Blue.
 * redWins: array of round ids won by Red.
 */
function makeRoundsCompact(blueWins: number[], redWins: number[]): string {
  const rounds = [
    ...blueWins.map((r) => ({ r, w: 'Blue' })),
    ...redWins.map((r) => ({ r, w: 'Red' })),
  ].sort((a, b) => a.r - b.r);
  return JSON.stringify(rounds);
}

describe('matchComebackDetector', () => {
  it('emits when team had exactly 8-round deficit and won 13:11', () => {
    // Blue wins rounds 1-2 then 13-23; Red wins rounds 3-12 then 24.
    // After round 12: Blue=2, Red=10 → deficit=8.
    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('match_comeback');
    expect(events[0]!.payload.max_deficit).toBe(8);
    expect(events[0]!.payload.deficit_score_player).toBe(2);
    expect(events[0]!.payload.deficit_score_opponent).toBe(10);
    expect(events[0]!.payload.final_score_player).toBe(13);
    expect(events[0]!.payload.final_score_opponent).toBe(11);
  });

  it('emits with max_deficit=10 when trailing 0:10 then won 13:11', () => {
    // Red wins rounds 1-10, then Blue wins rounds 11-23, Red wins 24.
    // After round 10: Blue=0, Red=10 → deficit=10.
    const redWins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 24];
    const blueWins = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.max_deficit).toBe(10);
    expect(events[0]!.payload.deficit_score_player).toBe(0);
    expect(events[0]!.payload.deficit_score_opponent).toBe(10);
  });

  it('does NOT emit when max deficit was only 7', () => {
    // Blue wins rounds 1-3, Red wins 4-10 (Blue=3, Red=7, deficit=4 — not 8).
    // Actually: Blue=3, Red=7, deficit=4. Not enough.
    // Let's try: Blue 2, Red 9 → deficit=7. Not ≥8.
    const blueWins = [1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 20, 21];
    // After round 9: Blue=2, Red=7, deficit=5. Let's recalculate...
    // Actually build a simpler case: Blue wins 1, Red wins 2-8 (7 wins), then Blue wins the rest.
    // After round 8: Blue=1, Red=7, deficit=6. Still not 8.
    // Blue wins 1, Red wins 2-9 (8 Red wins), Blue wins rest to win 13:8.
    // After round 9: Blue=1, Red=8, deficit=7. NOT ≥8.
    const blueWins2 = [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const redWins2 = [2, 3, 4, 5, 6, 7, 8, 9];
    // After round 9: Blue=1, Red=8, deficit=7. Blue wins rest, ends 13:8.
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins2, redWins2),
      team_rounds_won: 13,
      team_rounds_lost: 8,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when result is loss', () => {
    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22, 23, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      result: 'loss',
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      team_rounds_won: 11,
      team_rounds_lost: 13,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when rounds_compact is null (older match)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: null,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when rounds_compact is empty array', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: '[]',
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when team_rounds_won does not match any team count (corrupt data)', () => {
    // rounds_compact has Blue winning 13, Red winning 11, but team_rounds_won=99 (corrupt).
    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      team_rounds_won: 99,
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });

  it('handles invalid JSON in rounds_compact gracefully', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: 'not-valid-json',
    };
    const events = matchComebackDetector.detect(record, []);
    expect(events).toHaveLength(0);
  });
});
