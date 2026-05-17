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
  // Player's team in tests is 'Blue' (matches attacker_team in makeKill).
  // 'Blue' wins rounds 1,2,3; 'Red' wins round 5.
  rounds_compact: JSON.stringify([
    { r: 1, w: 'Blue' },
    { r: 2, w: 'Blue' },
    { r: 3, w: 'Blue' },
    { r: 5, w: 'Red' },
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

/** Five unique enemies (one full team) in one round. */
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
  it('returns empty when no aces', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1), makeKill(1), makeKill(2), makeKill(2), makeKill(3),
      ]),
    };
    expect(await aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('detects a single ace (5 unique-victim kills in one round)', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify(makeAceRound(3)),
    };
    const events = await aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('ace');
    expect(events[0]!.payload.rounds).toEqual([3]);
    expect(events[0]!.payload.total_aces).toBe(1);
    // Round 3 → 'Blue' wins → player's team → rounds_won includes 3.
    expect(events[0]!.payload.rounds_won).toEqual([3]);
  });

  it('detects an ace when 5 kill events with only 4 unique victims (Sage-revived enemy re-killed)', async () => {
    // Per ADR 0003: we deliberately count the revived re-kill toward the 5.
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-2'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-3'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-4'),
        // 5th event is a re-kill of enemy-1 (revived) — counts toward ace under new rules.
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
      ]),
    };
    const events = await aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    const wpr = events[0]!.payload.weapons_per_round as string[][];
    expect(wpr[0]).toHaveLength(5); // 5 kill events recorded, no dedup
    // Victims (for opponent peak) are still deduped → 4 unique.
    expect((events[0]!.payload.victims as unknown[])).toHaveLength(4);
  });

  it('detects ace even when CeremonyAce never fired (spike-explosion case)', async () => {
    // Player aced but died to spike before round end → Riot did not fire CeremonyAce.
    // rounds_compact carries CeremonyCloser, not CeremonyAce. Must still emit.
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: JSON.stringify([{ r: 4, w: 'Red', c: 'CeremonyCloser' }]),
      kill_events_compact: JSON.stringify(makeAceRound(4)),
    };
    const events = await aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    // Round 4 won by Red, player is Blue → rounds_won is empty.
    expect(events[0]!.payload.rounds_won).toEqual([]);
  });

  it('excludes self-kills (spike suicide) — attacker == victim does not count toward ace', async () => {
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
    expect(await aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('excludes friendly fire — same team kills do not count toward ace', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-2'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-3'),
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-4'),
        // 5th is a teammate kill (same team as attacker).
        { round: 1, attacker_team: 'Blue', victim_team: 'Blue', weapon: 'Vandal', attacker_puuid: 'puuid-1', victim_puuid: 'teammate-1' },
      ]),
    };
    expect(await aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('emits one event with both rounds when two aces in same match', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        ...makeAceRound(1),
        ...makeAceRound(5),
      ]),
    };
    const events = await aceDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.total_aces).toBe(2);
    expect(events[0]!.payload.rounds).toContain(1);
    expect(events[0]!.payload.rounds).toContain(5);
    // Round 1 → Blue wins (player team) → in rounds_won; round 5 → Red wins → not in rounds_won.
    expect(events[0]!.payload.rounds_won).toEqual([1]);
  });

  it('only counts kills by the target player', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        ...makeAceRound(1).slice(0, 4), // 4 by player
        makeKill(1, 'Phantom', 'enemy-1', 'puuid-1'), // kill by enemy
      ]),
    };
    expect(await aceDetector.detect(record, [])).toHaveLength(0);
  });

  it('handles malformed kill_events_compact gracefully', async () => {
    const record: MatchRecord = { ...BASE_RECORD, kill_events_compact: 'invalid json' };
    expect(await aceDetector.detect(record, [])).toHaveLength(0);
  });
});

describe('aceDetector.enrich (relocated opponent-peak seam)', () => {
  const ctxBase = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    riot_puuid: 'puuid-1',
    match_id: 'match-1',
  };

  function aceEvent() {
    return {
      type: 'ace' as const,
      riot_puuid: 'puuid-1',
      match_id: 'match-1',
      payload: {
        rounds: [1],
        victims: [
          { puuid: 'enemy-1', name: 'E1', tag: 'T1' },
          { puuid: 'enemy-2', name: 'E2', tag: 'T2' },
        ],
      } as Record<string, unknown>,
    };
  }

  it('merges opponents_peak into every ace event payload', async () => {
    const peakMap = new Map([
      ['enemy-1', { tier_id: 21, tier_name: 'Diamond 2', season_short: 'e9a1' }],
      ['enemy-2', { tier_id: 24, tier_name: 'Ascendant 1', season_short: 'e9a1' }],
    ]);
    const getOpponentPeakRanksFn = async () => peakMap;
    const events = [aceEvent()];
    const out = await aceDetector.enrich!(events, {
      ...ctxBase,
      region: 'eu',
      getOpponentPeakRanksFn,
    });
    const peak = out[0]!.payload['opponents_peak'] as Record<string, { tier_name: string }>;
    expect(peak['enemy-1']).toMatchObject({ tier_name: 'Diamond 2' });
    expect(peak['enemy-2']).toMatchObject({ tier_name: 'Ascendant 1' });
  });

  it('no region → events returned unchanged, peak fn not called', async () => {
    let called = false;
    const events = [aceEvent()];
    const out = await aceDetector.enrich!(events, {
      ...ctxBase,
      region: null,
      getOpponentPeakRanksFn: async () => {
        called = true;
        return new Map();
      },
    });
    expect(called).toBe(false);
    expect(out[0]!.payload['opponents_peak']).toBeUndefined();
  });

  it('no events → returned unchanged', async () => {
    const out = await aceDetector.enrich!([], {
      ...ctxBase,
      region: 'eu',
      getOpponentPeakRanksFn: async () => new Map(),
    });
    expect(out).toEqual([]);
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

  it('returns ace rounds with correct weapons in kill order', () => {
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
    expect(aces[0]!.weapons).toEqual(['Knife', 'Knife', 'Vandal', 'Vandal', 'Phantom']);
  });

  it('sets won=true when player team won the ace round', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify(makeAceRound(1)),
    };
    const aces = findAces(record);
    expect(aces[0]!.won).toBe(true);
  });

  it('sets won=false when ace round was lost', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify(makeAceRound(5)), // round 5 — Red wins
    };
    const aces = findAces(record);
    expect(aces[0]!.won).toBe(false);
  });
});
