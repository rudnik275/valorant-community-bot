import { describe, it, expect } from 'vitest';
import { clutchDetector } from './clutch.ts';
import type { MatchRecord } from '../types.ts';
import { deriveMatchRecord } from '../../scanner/derive.ts';
import type { HenrikMatchV4 } from '../../lib/henrik.ts';
import comebackFixture from '../../scanner/__fixtures__/henrik-match-comeback.json';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Split',
  agent: 'Omen',
  kills: 10,
  deaths: 8,
  assists: 3,
  result: 'win',
  rounds_played: 24,
  rank_before: null,
  rank_after: 'Gold 3',
  enemy_avg_rank: 'Gold 2',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  rounds_compact: null,
  per_round_afk_compact: null,
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
  survived_last_rounds: null,  died_first_rounds: null,  performance_score: null,  rr_change: null,  inserted_at: 1700000000000,
};

function withRounds(rounds: unknown[]): MatchRecord {
  return { ...BASE_RECORD, rounds_compact: JSON.stringify(rounds) };
}

describe('clutchDetector', () => {
  it('emits ONE event with count and round ids for every round Riot credits to the player as a clutch', async () => {
    const events = await clutchDetector.detect(
      withRounds([
        { r: 1, w: 'Blue' },
        { r: 3, w: 'Blue', c: 'CeremonyClutch', cp: 'puuid-1' },
        { r: 5, w: 'Red' },
        { r: 9, w: 'Blue', c: 'CeremonyClutch', cp: 'puuid-1', fb: 'enemy-1', fbt: 'Red' },
      ]),
      [],
    );
    expect(events).toEqual([
      {
        type: 'clutch',
        riot_puuid: 'puuid-1',
        match_id: 'match-1',
        payload: { count: 2, rounds: [3, 9], rounds_won: [3, 9] },
      },
    ]);
  });

  it('ignores an ace ceremony credited to the player — only CeremonyClutch is a clutch', async () => {
    const events = await clutchDetector.detect(
      withRounds([{ r: 4, w: 'Blue', c: 'CeremonyAce', cp: 'puuid-1' }]),
      [],
    );
    expect(events).toEqual([]);
  });

  it('ignores a clutch Riot credits to someone else (teammate or enemy)', async () => {
    const events = await clutchDetector.detect(
      withRounds([
        { r: 6, w: 'Blue', c: 'CeremonyClutch', cp: 'teammate-2' },
        { r: 7, w: 'Red', c: 'CeremonyClutch', cp: 'enemy-1' },
      ]),
      [],
    );
    expect(events).toEqual([]);
  });

  it('ignores a clutch ceremony with no ceremony player — rows scanned before #389 carry no cp', async () => {
    const events = await clutchDetector.detect(
      withRounds([{ r: 2, w: 'Blue', c: 'CeremonyClutch' }]),
      [],
    );
    expect(events).toEqual([]);
  });

  it('emits nothing for null, empty or invalid rounds_compact', async () => {
    for (const rounds_compact of [null, '', '[]', 'not-json', '{"r":1}']) {
      const events = await clutchDetector.detect({ ...BASE_RECORD, rounds_compact }, []);
      expect(events, String(rounds_compact)).toEqual([]);
    }
  });

  it('detects a clutch end-to-end from a Henrik v4.10 match (scanner derive → detector)', async () => {
    // Real Henrik shape: round 18 is a clutch by our player, round 21 a
    // teammate's clutch, round 15 keeps the fixture's own CeremonyAce.
    const fixture = comebackFixture as unknown as HenrikMatchV4;
    const clutchBy = (puuid: string) => ({ puuid, name: 'X', tag: 'EU1', team: 'Blue' });
    const match = {
      ...fixture,
      rounds: fixture.rounds.map((r) =>
        r.id === 18
          ? { ...r, ceremony: 'CeremonyClutch', ceremony_player: clutchBy('target-puuid') }
          : r.id === 21
            ? { ...r, ceremony: 'CeremonyClutch', ceremony_player: clutchBy('ally-2') }
            : r,
      ),
    } as HenrikMatchV4;
    const record = deriveMatchRecord(match, 'target-puuid')!;

    const events = await clutchDetector.detect(record as MatchRecord, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.match_id).toBe(record.match_id);
    expect(events[0]!.payload).toEqual({ count: 1, rounds: [18], rounds_won: [18] });

    // The untouched fixture has an ace ceremony but no clutch.
    const plain = deriveMatchRecord(fixture, 'target-puuid')!;
    expect(await clutchDetector.detect(plain as MatchRecord, [])).toEqual([]);
  });
});
