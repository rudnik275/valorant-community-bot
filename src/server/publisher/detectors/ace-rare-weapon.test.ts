import { describe, it, expect } from 'vitest';
import { aceRareWeaponDetector } from './ace-rare-weapon.ts';
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

describe('aceRareWeaponDetector', () => {
  it('returns empty when no kills at all', () => {
    expect(aceRareWeaponDetector.detect(BASE_RECORD, [])).toHaveLength(0);
  });

  it('returns empty when ace with no rare weapons', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Vandal', 'puuid-1', 'e1'), makeKill(1, 'Vandal', 'puuid-1', 'e2'), makeKill(1, 'Phantom', 'puuid-1', 'e3'),
        makeKill(1, 'Operator', 'puuid-1', 'e4'), makeKill(1, 'Sheriff', 'puuid-1', 'e5'),
      ]),
    };
    expect(aceRareWeaponDetector.detect(record, [])).toHaveLength(0);
  });

  it('returns empty when only 1 rare weapon kill in ace', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Knife', 'puuid-1', 'e1'), makeKill(1, 'Vandal', 'puuid-1', 'e2'), makeKill(1, 'Phantom', 'puuid-1', 'e3'),
        makeKill(1, 'Operator', 'puuid-1', 'e4'), makeKill(1, 'Sheriff', 'puuid-1', 'e5'),
      ]),
    };
    expect(aceRareWeaponDetector.detect(record, [])).toHaveLength(0);
  });

  it('detects ace with ≥2 Knife kills', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Knife', 'puuid-1', 'e1'), makeKill(1, 'Knife', 'puuid-1', 'e2'), makeKill(1, 'Phantom', 'puuid-1', 'e3'),
        makeKill(1, 'Vandal', 'puuid-1', 'e4'), makeKill(1, 'Vandal', 'puuid-1', 'e5'),
      ]),
    };
    const events = aceRareWeaponDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('ace_rare_weapon_week');
    expect(events[0]!.payload.rare_weapon_counts).toEqual([2]);
  });

  it('detects ace with ≥2 Classic kills', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(2, 'Classic', 'puuid-1', 'e1'), makeKill(2, 'Classic', 'puuid-1', 'e2'), makeKill(2, 'Classic', 'puuid-1', 'e3'),
        makeKill(2, 'Vandal', 'puuid-1', 'e4'), makeKill(2, 'Vandal', 'puuid-1', 'e5'),
      ]),
    };
    const events = aceRareWeaponDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.rare_weapon_counts).toEqual([3]);
  });

  it('returns empty when kills < 5 in any round (no ace)', () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      kill_events_compact: JSON.stringify([
        makeKill(1, 'Knife'), makeKill(1, 'Knife'), makeKill(1, 'Knife'), makeKill(1, 'Knife'),
      ]),
    };
    expect(aceRareWeaponDetector.detect(record, [])).toHaveLength(0);
  });
});
