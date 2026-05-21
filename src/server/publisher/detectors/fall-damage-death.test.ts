import { describe, it, expect } from 'vitest';
import { fallDamageDeathDetector } from './fall-damage-death.ts';
import type { MatchRecord } from '../types.ts';

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-1',
  started_at: 1700000000000,
  map: 'Breeze',
  agent: 'Killjoy',
  kills: 8,
  deaths: 10,
  assists: 5,
  result: 'loss',
  rounds_played: 20,
  rank_before: null,
  rank_after: 'Iron 2',
  enemy_avg_rank: 'Iron 3',
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
  survived_last_rounds: null,  died_first_rounds: null,  inserted_at: 1700000000000,
};

describe('fallDamageDeathDetector', () => {
  it('detects fall damage kill', async () => {
    const record: MatchRecord = { ...BASE_RECORD, fall_damage_kills: 1 };
    const events = await fallDamageDeathDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('fall_damage_death');
    expect(events[0]!.payload.count).toBe(1);
  });

  it('detects multiple fall damage kills as one event', async () => {
    const record: MatchRecord = { ...BASE_RECORD, fall_damage_kills: 3 };
    const events = await fallDamageDeathDetector.detect(record, []);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.count).toBe(3);
  });

  it('does NOT emit when fall_damage_kills is 0', async () => {
    expect(await fallDamageDeathDetector.detect(BASE_RECORD, [])).toHaveLength(0);
  });
});
