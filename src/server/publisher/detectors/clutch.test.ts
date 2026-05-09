import { describe, it, expect } from 'vitest';
import { clutchDetector } from './clutch.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Ascent',
  agent: 'Jett',
  kills: 15,
  deaths: 5,
  assists: 2,
  result: 'win',
  rounds_played: 25,
  rank_before: 'Diamond 1',
  rank_after: 'Diamond 2',
  enemy_avg_rank: 'Diamond 1',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  inserted_at: 1700000000000,
};

function makeKill(
  round: number,
  attacker = 'puuid-1',
  victim = 'enemy-1',
  team = 'Blue',
  victimTeam = 'Red',
) {
  return {
    round,
    attacker_team: team,
    victim_team: victimTeam,
    weapon: 'Vandal',
    attacker_puuid: attacker,
    victim_puuid: victim,
  };
}

describe('clutchDetector', () => {
  it('detects clutch: player is last killer and made 3+ kills in a won round', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(5, 'puuid-1', 'e1'),
        makeKill(5, 'puuid-1', 'e2'),
        makeKill(5, 'puuid-1', 'e3'), // last killer in round 5 with 3 kills → clutch
      ]),
    };
    const events = clutchDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('clutch_1vN');
    expect((events[0]!.payload.rounds as {round: number; kills: number}[])[0]!.kills).toBe(3);
  });

  it('does NOT emit clutch when result is loss', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      result: 'loss',
      kill_events_compact: JSON.stringify([
        makeKill(3, 'puuid-1', 'e1'),
        makeKill(3, 'puuid-1', 'e2'),
        makeKill(3, 'puuid-1', 'e3'),
      ]),
    };
    expect(clutchDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when player made fewer than 3 kills in the round', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(2, 'puuid-1', 'e1'),
        makeKill(2, 'puuid-1', 'e2'), // only 2 kills in round → not clutch
      ]),
    };
    expect(clutchDetector.detect(record, [])).toHaveLength(0);
  });

  it('does NOT emit when another player made the last kill', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(4, 'puuid-1', 'e1'),
        makeKill(4, 'puuid-1', 'e2'),
        makeKill(4, 'puuid-1', 'e3'),
        makeKill(4, 'teammate-2', 'e4'), // teammate got the last kill
      ]),
    };
    expect(clutchDetector.detect(record, [])).toHaveLength(0);
  });

  it('detects multiple clutch rounds in same match as one event', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'puuid-1', 'e1'),
        makeKill(1, 'puuid-1', 'e2'),
        makeKill(1, 'puuid-1', 'e3'),
        makeKill(8, 'puuid-1', 'e4'),
        makeKill(8, 'puuid-1', 'e5'),
        makeKill(8, 'puuid-1', 'e6'),
        makeKill(8, 'puuid-1', 'e7'),
      ]),
    };
    const events = clutchDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload.rounds as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});
