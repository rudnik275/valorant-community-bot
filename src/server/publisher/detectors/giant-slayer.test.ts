import { describe, it, expect } from 'vitest';
import { giantSlayerDetector } from './giant-slayer.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Ascent',
  agent: 'Jett',
  kills: 20,
  deaths: 8,
  assists: 3,
  result: 'win',
  rounds_played: 25,
  rank_before: 'Silver 2',
  rank_after: 'Silver 3',
  enemy_avg_rank: 'Platinum',
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
  is_match_mvp: null,
  inserted_at: 1700000000000,
};

describe('giantSlayerDetector', () => {
  it('detects giant slayer when enemy is 2 tiers higher (Silver vs Platinum)', () => {
    // Silver=3, Platinum=5, delta=2 → qualifies
    const events = giantSlayerDetector.detect(BASE_RECORD, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('giant_slayer');
    expect(events[0]!.payload.delta).toBeGreaterThanOrEqual(1.5);
  });

  it('detects giant slayer at exact threshold 1.5', () => {
    // Bronze=2, Gold=4 → delta=2 → qualifies; we need delta exactly 1.5 which is between tiers
    // Iron=1, Gold=4 would be 3; Diamond=6 vs Ascendant=7 is 1 tier, not enough
    // Use Silver=3, Ascendant=7 → delta=4 → qualifies
    const record: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Silver 3',
      enemy_avg_rank: 'Ascendant',
    };
    const events = giantSlayerDetector.detect(record, []);
    expect(events).toHaveLength(1);
  });

  it('does NOT emit when delta is less than 1.5 (1 tier difference)', () => {
    // Silver=3, Gold=4 → delta=1 → not enough
    const record: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Silver 3',
      enemy_avg_rank: 'Gold 1',
    };
    expect(giantSlayerDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when result is not win', () => {
    const record: MatchRecord = { ...BASE_RECORD, result: 'loss' };
    expect(giantSlayerDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when rank is unknown/null', () => {
    const record: MatchRecord = { ...BASE_RECORD, rank_after: null };
    expect(giantSlayerDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when enemy_avg_rank is null', () => {
    const record: MatchRecord = { ...BASE_RECORD, enemy_avg_rank: null };
    expect(giantSlayerDetector.detect(record, [])).toHaveLength(0);
  });
});
