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
  rounds_compact: null,
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
  it('detects giant slayer when enemy is 2 macro tiers higher (Silver vs Platinum)', () => {
    // Silver=3, Platinum=5, delta=2 → qualifies (≥2 macro tiers)
    const events = giantSlayerDetector.detect(BASE_RECORD, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('giant_slayer');
    expect(events[0]!.payload.delta).toBeGreaterThanOrEqual(2);
  });

  it('detects giant slayer at exact threshold 2 (Silver vs Platinum boundary)', () => {
    // Silver=3, Platinum=5 → delta=2 → exactly at threshold → qualifies
    const record: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Silver 3',
      enemy_avg_rank: 'Platinum',
    };
    const events = giantSlayerDetector.detect(record, []);
    expect(events).toHaveLength(1);
  });

  it('detects giant slayer: Gold I vs Diamond III (delta=2 macro, ignoring subtier)', () => {
    // Gold=4, Diamond=6 → delta=2 → qualifies
    const record: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Gold 1',
      enemy_avg_rank: 'Diamond 3',
    };
    const events = giantSlayerDetector.detect(record, []);
    expect(events).toHaveLength(1);
  });

  it('does NOT emit when delta is 1 (Gold III vs Platinum I — 1 macro tier)', () => {
    // Gold=4, Platinum=5 → delta=1 → not enough
    const record: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Gold 3',
      enemy_avg_rank: 'Platinum 1',
    };
    expect(giantSlayerDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when delta is less than 2 (1 tier difference — Silver vs Gold)', () => {
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
