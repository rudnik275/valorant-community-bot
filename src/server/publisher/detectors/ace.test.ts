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
  rounds_compact: JSON.stringify([
    { r: 1, w: 'Blue', c: 'CeremonyAce' },
    { r: 2, w: 'Blue', c: 'CeremonyAce' },
    { r: 3, w: 'Blue', c: 'CeremonyAce' },
    { r: 5, w: 'Blue', c: 'CeremonyAce' },
  ]),
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

function makeKill(round: number, weapon = 'Vandal', attacker = 'puuid-1', victim = 'enemy-1') {
  return { round, attacker_team: 'Blue', victim_team: 'Red', weapon, attacker_puuid: attacker, victim_puuid: victim };
}

/** Five unique enemies (one full team) in one round — a real ace shape. */
function makeAceRound(round: number, weapon = 'Vandal') {
  return [
    makeKill(round, weapon, 'puuid-1', 'enemy-1'),
    makeKill(round, weapon, 'puuid-1', 'enemy-2'),
    makeKill(round, weapon, 'puuid-1', 'enemy-3'),
    makeKill(round, weapon, 'puuid-1', 'enemy-4'),
    makeKill(round, weapon, 'puuid-1', 'enemy-5'),
  ];
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

  it('detects a single ace (5 unique-victim kills in one round)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify(makeAceRound(3)),
    };
    const events = aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('ace');
    expect(events[0]!.payload.rounds).toEqual([3]);
    expect(events[0]!.payload.total_aces).toBe(1);
  });

  it('handles 6 kill events with 5 unique victims (Phoenix Run-It-Back dupe) — still an ace', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        ...makeAceRound(2),
        // Phoenix-shadow died first, then real Phoenix — same victim_puuid twice.
        makeKill(2, 'Vandal', 'puuid-1', 'enemy-1'),
      ]),
    };
    const events = aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    // Unique-victim count: still 5, NOT 6.
    expect((events[0]!.payload.weapons_per_round as string[][])[0]).toHaveLength(5);
  });

  it('does NOT detect an ace when only 4 unique victims even if 5 kill events (Phoenix dupe)', () => {
    // Regression for #211-bot's false-ace post: 4 real kills + 1 Phoenix-shadow re-kill
    // was being counted as 5 → ace. Must NOT fire.
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-2'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-3'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-4'),
        // 5th event is a re-kill of enemy-1 (Phoenix Run-It-Back) — should not bump count.
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
      ]),
    };
    expect(aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('excludes self-kills (spike suicide) — attacker == victim does not count toward ace', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-2'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-3'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-4'),
        // Spike detonation logged by Henrik as Yarmaru killing Yarmaru.
        makeKill(1, 'Fall', 'puuid-1', 'puuid-1'),
      ]),
    };
    expect(aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('emits one event with both rounds when two aces in same match', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        ...makeAceRound(1),
        ...makeAceRound(5),
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
        ...makeAceRound(1).slice(0, 4), // 4 by player
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
        makeKill(2, 'Knife', 'puuid-1', 'enemy-1'),
        makeKill(2, 'Knife', 'puuid-1', 'enemy-2'),
        makeKill(2, 'Vandal', 'puuid-1', 'enemy-3'),
        makeKill(2, 'Vandal', 'puuid-1', 'enemy-4'),
        makeKill(2, 'Phantom', 'puuid-1', 'enemy-5'),
      ]),
    };
    const aces = findAces(record);
    expect(aces).toHaveLength(1);
    expect(aces[0]!.round).toBe(2);
    expect(aces[0]!.weapons).toContain('Knife');
  });
});
