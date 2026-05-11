import { describe, it, expect } from 'vitest';
import { knifeKillDetector } from './knife-kill.ts';
import type { MatchRecord } from '../types.ts';

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

function makeKill(
  round: number,
  weapon: string,
  attacker_puuid: string,
  victim_puuid: string,
) {
  return {
    round,
    attacker_team: 'Blue',
    victim_team: 'Red',
    weapon,
    attacker_puuid,
    victim_puuid,
  };
}

describe('knifeKillDetector', () => {
  it('emits one event with count=1 when player makes 1 knife kill', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(3, 'Knife', 'puuid-1', 'enemy-1'),
      ]),
    };
    const events = knifeKillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('knife_kill');
    expect(events[0]!.payload.count).toBe(1);
    expect(events[0]!.payload.rounds).toEqual([3]);
  });

  it('emits one event with count=3 when player makes 3 knife kills', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Knife', 'puuid-1', 'enemy-1'),
        makeKill(5, 'Knife', 'puuid-1', 'enemy-2'),
        makeKill(12, 'Knife', 'puuid-1', 'enemy-3'),
      ]),
    };
    const events = knifeKillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.count).toBe(3);
    expect(events[0]!.payload.rounds).toEqual([1, 5, 12]);
  });

  it('does NOT emit when community player is the victim of a knife kill', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(3, 'Knife', 'enemy-1', 'puuid-1'), // enemy knifed our player
      ]),
    };
    expect(knifeKillDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when there are no knife kills', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(2, 'Phantom', 'puuid-1', 'enemy-2'),
      ]),
    };
    expect(knifeKillDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when knife kill is by a different puuid (not matching record.riot_puuid)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(4, 'Knife', 'teammate-2', 'enemy-1'), // different player's knife kill
      ]),
    };
    expect(knifeKillDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit for empty kill_events_compact string', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: '',
    };
    expect(knifeKillDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit for invalid JSON in kill_events_compact', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: 'not-json',
    };
    expect(knifeKillDetector.detect(record, [])).toHaveLength(0);
  });

  it('also recognises the canonical knife UUID as a knife weapon', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(7, '2f59173c-4bed-b6c3-2191-dea9b58be9c7', 'puuid-1', 'enemy-1'),
      ]),
    };
    const events = knifeKillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.count).toBe(1);
  });

  it('counts only knife kills, ignoring other weapon kills in the same match', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'enemy-1'),
        makeKill(2, 'Knife', 'puuid-1', 'enemy-2'),
        makeKill(3, 'Phantom', 'puuid-1', 'enemy-3'),
      ]),
    };
    const events = knifeKillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.count).toBe(1);
    expect(events[0]!.payload.rounds).toEqual([2]);
  });

  it('sets correct match_id and riot_puuid on the event', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      match_id: 'match-xyz',
      riot_puuid: 'puuid-abc',
      kill_events_compact: JSON.stringify([
        makeKill(5, 'Knife', 'puuid-abc', 'enemy-1'),
      ]),
    };
    const events = knifeKillDetector.detect(record, []);
    expect(events[0]!.match_id).toBe('match-xyz');
    expect(events[0]!.riot_puuid).toBe('puuid-abc');
  });
});
