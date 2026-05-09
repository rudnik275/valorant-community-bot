import { describe, it, expect } from 'vitest';
import { aceDetector, findAces } from './ace.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Ascent',
  agent: 'Jett',
  kills: 20,
  deaths: 10,
  assists: 5,
  result: 'win',
  rounds_played: 25,
  rank_before: 'Diamond 1',
  rank_after: 'Diamond 2',
  enemy_avg_rank: 'Diamond 1',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  inserted_at: 1700000000000,
};

function makeKill(round: number, weapon = 'Vandal', attacker = 'puuid-1', victim = 'enemy-1') {
  return { round, attacker_team: 'Blue', victim_team: 'Red', weapon, attacker_puuid: attacker, victim_puuid: victim };
}

describe('aceDetector', () => {
  it('returns empty when no aces', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1), makeKill(1), makeKill(2), makeKill(2), makeKill(3),
      ]),
    };
    expect(aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('detects a single ace (5 kills in one round)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(3), makeKill(3), makeKill(3), makeKill(3), makeKill(3),
      ]),
    };
    const events = aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('ace');
    expect(events[0]!.payload.rounds).toEqual([3]);
    expect(events[0]!.payload.total_aces).toBe(1);
  });

  it('handles 6 kills in one round without crashing (edge case)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(2), makeKill(2), makeKill(2), makeKill(2), makeKill(2), makeKill(2),
      ]),
    };
    const events = aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload.weapons_per_round as string[][])[0]).toHaveLength(6);
  });

  it('emits one event with both rounds when two aces in same match', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        // ace in round 1
        makeKill(1), makeKill(1), makeKill(1), makeKill(1), makeKill(1),
        // ace in round 5
        makeKill(5), makeKill(5), makeKill(5), makeKill(5), makeKill(5),
      ]),
    };
    const events = aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.total_aces).toBe(2);
    expect(events[0]!.payload.rounds).toContain(1);
    expect(events[0]!.payload.rounds).toContain(5);
  });

  it('only counts kills by the target player', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1), makeKill(1), makeKill(1), makeKill(1), // 4 by player
        makeKill(1, 'Phantom', 'enemy-1', 'puuid-1'), // kill by enemy
      ]),
    };
    expect(aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('handles malformed kill_events_compact gracefully', () => {
    const record: MatchRecord = { ...BASE_RECORD, kill_events_compact: 'invalid json' };
    expect(aceDetector.detect(record, [])).toHaveLength(0);
  });
});

describe('findAces', () => {
  it('returns empty array when no aces', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([makeKill(1), makeKill(1)]),
    };
    expect(findAces(record)).toHaveLength(0);
  });

  it('returns ace rounds with correct weapons', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(2, 'Knife'),
        makeKill(2, 'Knife'),
        makeKill(2, 'Vandal'),
        makeKill(2, 'Vandal'),
        makeKill(2, 'Phantom'),
      ]),
    };
    const aces = findAces(record);
    expect(aces).toHaveLength(1);
    expect(aces[0]!.round).toBe(2);
    expect(aces[0]!.weapons).toContain('Knife');
  });
});
