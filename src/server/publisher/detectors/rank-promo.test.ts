import { describe, it, expect, vi, afterEach } from 'vitest';
import { rankPromoDetector } from './rank-promo.ts';
import type { MatchRecord } from '../types.ts';

// CURRENT_ACT_START = Date.parse('2026-04-01T00:00:00Z') = 1775001600000
// Use timestamps well after that to be in-act
const ACT_START_PLUS_30_DAYS = 1777593600000; // 2026-05-01

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-2',
  started_at: ACT_START_PLUS_30_DAYS + 86_400_000, // 2026-05-02 (within act)
  map: 'Ascent',
  agent: 'Jett',
  kills: 15,
  deaths: 8,
  assists: 3,
  result: 'win',
  rounds_played: 25,
  rank_before: 'Diamond 3',
  rank_after: 'Ascendant 1',
  enemy_avg_rank: 'Diamond 2',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  inserted_at: ACT_START_PLUS_30_DAYS + 86_400_000,
};

const PREV_SAME_ACT: MatchRecord = {
  ...BASE_RECORD,
  match_id: 'match-1',
  started_at: ACT_START_PLUS_30_DAYS, // 2026-05-01 (slightly earlier, same act)
  rank_after: 'Diamond 3',
};

describe('rankPromoDetector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects tier promotion (Diamond → Ascendant)', () => {
    const events = rankPromoDetector.detect(BASE_RECORD, [PREV_SAME_ACT]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rank_promo');
    expect(events[0]!.payload.from_tier).toBe('Diamond');
    expect(events[0]!.payload.to_tier).toBe('Ascendant');
  });

  it('does NOT emit when no prev records', () => {
    expect(rankPromoDetector.detect(BASE_RECORD, [])).toHaveLength(0);
  });

  it('does NOT emit on division increase within same tier', () => {
    const record: MatchRecord = { ...BASE_RECORD, rank_after: 'Diamond 3' };
    const prev: MatchRecord = { ...PREV_SAME_ACT, rank_after: 'Diamond 1' };
    expect(rankPromoDetector.detect(record, [prev])).toHaveLength(0);
  });

  it('does NOT emit on rank decrease (demotion)', () => {
    const record: MatchRecord = { ...BASE_RECORD, rank_after: 'Platinum 3' };
    const prev: MatchRecord = { ...PREV_SAME_ACT, rank_after: 'Diamond 1' };
    expect(rankPromoDetector.detect(record, [prev])).toHaveLength(0);
  });

  it('does NOT emit on cross-season comparison (prev match before act start)', () => {
    // prev match started before 2026-04-01 (CURRENT_ACT_START = 1743465600000)
    const crossSeasonPrev: MatchRecord = {
      ...PREV_SAME_ACT,
      started_at: 1700000000000, // Nov 2023 — well before the act
    };
    expect(rankPromoDetector.detect(BASE_RECORD, [crossSeasonPrev])).toHaveLength(0);
  });

  it('emits on tier jump skipping a tier (Bronze → Gold)', () => {
    const record: MatchRecord = { ...BASE_RECORD, rank_after: 'Gold 1' };
    const prev: MatchRecord = { ...PREV_SAME_ACT, rank_after: 'Bronze 3' };
    const events = rankPromoDetector.detect(record, [prev]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.from_tier).toBe('Bronze');
    expect(events[0]!.payload.to_tier).toBe('Gold');
  });
});
