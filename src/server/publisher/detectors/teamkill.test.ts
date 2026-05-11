import { describe, it, expect } from 'vitest';
import { teamkillDetector } from './teamkill.ts';
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
  attacker: string,
  victim: string,
  attackerTeam: string,
  victimTeam: string,
  weapon = 'Vandal',
) {
  return { round, attacker_team: attackerTeam, victim_team: victimTeam, weapon, attacker_puuid: attacker, victim_puuid: victim };
}

describe('teamkillDetector', () => {
  it('detects teamkill when player kills a teammate', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(3, 'puuid-1', 'teammate-2', 'Blue', 'Blue'), // teamkill
        makeKill(3, 'puuid-1', 'enemy-1', 'Blue', 'Red'), // normal kill
      ]),
    };
    const events = teamkillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('teamkill');
    expect(events[0]!.payload.round_numbers).toEqual([3]);
  });

  it('does NOT emit for normal kills (enemy)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'puuid-1', 'enemy-1', 'Blue', 'Red'),
        makeKill(2, 'puuid-1', 'enemy-2', 'Blue', 'Red'),
      ]),
    };
    expect(teamkillDetector.detect(record, [])).toHaveLength(0);
  });

  it('excludes self-kills (same puuid attacker = victim)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(5, 'puuid-1', 'puuid-1', 'Blue', 'Blue'), // self-kill (excluded)
      ]),
    };
    expect(teamkillDetector.detect(record, [])).toHaveLength(0);
  });

  it('collects multiple teamkill rounds in one event', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(2, 'puuid-1', 'teammate-2', 'Blue', 'Blue'),
        makeKill(7, 'puuid-1', 'teammate-3', 'Blue', 'Blue'),
      ]),
    };
    const events = teamkillDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.round_numbers).toEqual([2, 7]);
  });

  it('does NOT emit kills made by other players on the same team', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(4, 'teammate-2', 'puuid-1', 'Blue', 'Blue'), // teammate killed target player
      ]),
    };
    expect(teamkillDetector.detect(record, [])).toHaveLength(0);
  });
});
