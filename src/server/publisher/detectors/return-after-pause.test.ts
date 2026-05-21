import { describe, it, expect } from 'vitest';
import { returnAfterPauseDetector } from './return-after-pause.ts';
import type { MatchRecord } from '../types.ts';

const MS_PER_DAY = 86_400_000;
const NOW = 1750000000000;

function makeRecord(matchId: string, startedAt: number): MatchRecord {
  return {
    riot_puuid: 'puuid-1',
    match_id: matchId,
    started_at: startedAt,
    map: 'Bind',
    agent: 'Reyna',
    kills: 12,
    deaths: 8,
    assists: 2,
    result: 'win',
    rounds_played: 20,
    rank_before: null,
    rank_after: 'Gold 2',
    enemy_avg_rank: 'Gold 1',
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
    survived_last_rounds: null,    inserted_at: startedAt,
  };
}

describe('returnAfterPauseDetector', () => {
  it('detects return_after_pause after 14+ day pause', async () => {
    const record = makeRecord('current', NOW);
    const prev = makeRecord('prev', NOW - 15 * MS_PER_DAY);
    const events = await returnAfterPauseDetector.detect(record, [prev]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('return_after_pause');
    expect(events[0]!.payload.days_paused).toBe(15);
  });

  it('does NOT emit when pause is exactly 13 days', async () => {
    const record = makeRecord('current', NOW);
    const prev = makeRecord('prev', NOW - 13 * MS_PER_DAY);
    expect(await returnAfterPauseDetector.detect(record, [prev])).toHaveLength(0);
  });

  it('detects return_after_pause at exactly 14 days', async () => {
    const record = makeRecord('current', NOW);
    const prev = makeRecord('prev', NOW - 14 * MS_PER_DAY);
    const events = await returnAfterPauseDetector.detect(record, [prev]);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.days_paused).toBe(14);
  });

  it('does NOT emit when prevRecords is empty (first match)', async () => {
    const record = makeRecord('current', NOW);
    expect(await returnAfterPauseDetector.detect(record, [])).toHaveLength(0);
  });

  it('includes rounded days in payload', async () => {
    const record = makeRecord('current', NOW);
    const prev = makeRecord('prev', NOW - 20.7 * MS_PER_DAY);
    const events = await returnAfterPauseDetector.detect(record, [prev]);
    expect(events[0]!.payload.days_paused).toBe(21);
  });
});
