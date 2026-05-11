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

  it('DOES emit when no prev records (first competitive match this season)', () => {
    // With no prev records, seasonPrev is empty → maxPrevTierNum = 0.
    // Any tier > 0, so the detector fires — this is the first match this season.
    const events = rankPromoDetector.detect(BASE_RECORD, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rank_promo');
    expect(events[0]!.payload.from).toBeNull();
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

  it('DOES emit when only cross-season records exist (treated as first match this season)', () => {
    // All prev records started before 2026-04-01 (CURRENT_ACT_START = 1743465600000)
    // seasonPrev will be empty → maxPrevTierNum = 0 → current tier > 0 → fires
    const crossSeasonPrev: MatchRecord = {
      ...PREV_SAME_ACT,
      started_at: 1700000000000, // Nov 2023 — well before the act
    };
    const events = rankPromoDetector.detect(BASE_RECORD, [crossSeasonPrev]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rank_promo');
  });

  it('emits on tier jump skipping a tier (Bronze → Gold)', () => {
    const record: MatchRecord = { ...BASE_RECORD, rank_after: 'Gold 1' };
    const prev: MatchRecord = { ...PREV_SAME_ACT, rank_after: 'Bronze 3' };
    const events = rankPromoDetector.detect(record, [prev]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.from_tier).toBe('Bronze');
    expect(events[0]!.payload.to_tier).toBe('Gold');
  });

  // === New cases (peak-aware filter) ===

  it('does NOT emit when player re-achieves a tier already reached this season (peak re-achievement)', () => {
    // Season start = 2026-04-01 (ACT_START_PLUS_30_DAYS - 30 days ≈ 1775001600000)
    const SEASON_START = 1775001600000; // 2026-04-01T00:00:00Z
    // Player hit Ascendant 2 earlier this season
    const peakRecord: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-peak',
      started_at: SEASON_START + 86_400_000, // 1 day into season
      rank_after: 'Ascendant 2',
    };
    // Then dropped to Diamond 3 (several matches)
    const dropRecord: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-drop',
      started_at: SEASON_START + 86_400_000 * 5,
      rank_after: 'Diamond 3',
    };
    const laterDrop: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-drop2',
      started_at: SEASON_START + 86_400_000 * 10,
      rank_after: 'Diamond 3',
    };
    // Now climbing back to Ascendant 1 (< Ascendant 2 peak → suppress)
    const currentRecord: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Ascendant 1',
    };
    // prevRecords ordered newest first
    const events = rankPromoDetector.detect(currentRecord, [laterDrop, dropRecord, peakRecord]);
    expect(events).toHaveLength(0);
  });

  it('emits when player breaks their true season peak (Ascendant 3 → Immortal 1)', () => {
    const SEASON_START = 1775001600000;
    const seasonMaxRecord: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-asc3',
      started_at: SEASON_START + 86_400_000 * 2,
      rank_after: 'Ascendant 3',
    };
    // Immediate prev is Diamond 3 (most recent match)
    const immPrev: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-d3',
      started_at: SEASON_START + 86_400_000 * 20,
      rank_after: 'Diamond 3',
    };
    const currentRecord: MatchRecord = {
      ...BASE_RECORD,
      rank_after: 'Immortal 1',
    };
    const events = rankPromoDetector.detect(currentRecord, [immPrev, seasonMaxRecord]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('rank_promo');
    expect(events[0]!.payload.to_tier).toBe('Immortal');
    // payload.from is the immediate prev (Diamond 3), not the season max (Ascendant 3)
    expect(events[0]!.payload.from).toBe('Diamond 3');
  });

  it('payload.from uses immediate prev rank_after, not season-max', () => {
    const SEASON_START = 1775001600000;
    // Season max: Ascendant 1 (3 days ago in season)
    const seasonMaxRecord: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-asc1',
      started_at: SEASON_START + 86_400_000 * 3,
      rank_after: 'Ascendant 1',
    };
    // Immediate prev (yesterday): Diamond 3
    const immPrev: MatchRecord = {
      ...PREV_SAME_ACT,
      match_id: 'match-d3-yesterday',
      started_at: ACT_START_PLUS_30_DAYS + 86_400_000 * 15,
      rank_after: 'Diamond 3',
    };
    // Current match: Immortal 1 (breaks peak)
    const currentRecord: MatchRecord = {
      ...BASE_RECORD,
      started_at: ACT_START_PLUS_30_DAYS + 86_400_000 * 16,
      rank_after: 'Immortal 1',
    };
    // prevRecords newest-first: immPrev is [0], seasonMaxRecord is [1]
    const events = rankPromoDetector.detect(currentRecord, [immPrev, seasonMaxRecord]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.from).toBe('Diamond 3');
    expect(events[0]!.payload.from).not.toBe('Ascendant 1');
    expect(events[0]!.payload.to).toBe('Immortal 1');
  });
});
