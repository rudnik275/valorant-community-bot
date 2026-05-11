import { describe, it, expect } from 'vitest';
import { zeroMatchDetector } from './zero-match.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Pearl',
  agent: 'Fade',
  kills: 0,
  deaths: 12,
  assists: 4,
  result: 'loss',
  rounds_played: 20,
  rank_before: null,
  rank_after: 'Iron 1',
  enemy_avg_rank: 'Iron 2',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  score: null,
  headshots: null,
  bodyshots: null,
  legshots: null,
  damage_dealt: null,
  damage_received: null,
  team_rounds_won: null,
  team_rounds_lost: null,
  game_length_ms: null,
  inserted_at: 1700000000000,
};

describe('zeroMatchDetector', () => {
  it('detects zero kills match with ≥10 rounds', () => {
    const events = zeroMatchDetector.detect(BASE_RECORD, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('zero_match');
    expect(events[0]!.payload.rounds).toBe(20);
    expect(events[0]!.payload.deaths).toBe(12);
  });

  it('does NOT emit when kills > 0', () => {
    const record: MatchRecord = { ...BASE_RECORD, kills: 1 };
    expect(zeroMatchDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when rounds_played < 10 (short/surrendered match)', () => {
    const record: MatchRecord = { ...BASE_RECORD, rounds_played: 9 };
    expect(zeroMatchDetector.detect(record, [])).toHaveLength(0);
  });

  it('detects at exactly 10 rounds', () => {
    const record: MatchRecord = { ...BASE_RECORD, rounds_played: 10 };
    const events = zeroMatchDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.rounds).toBe(10);
  });
});
