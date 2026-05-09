import { describe, it, expect } from 'vitest';
import { lostrickDetector } from './lostrick.ts';
import type { MatchRecord } from '../types.ts';

function makeRecord(matchId: string, result: 'win' | 'loss' | 'draw', startedAt: number): MatchRecord {
  return {
    riot_puuid: 'puuid-1',
    match_id: matchId,
    started_at: startedAt,
    map: 'Haven',
    agent: 'Sage',
    kills: 5,
    deaths: 15,
    assists: 1,
    result,
    rounds_played: 22,
    rank_before: null,
    rank_after: 'Bronze 2',
    enemy_avg_rank: 'Bronze 1',
    fall_damage_kills: 0,
    kill_events_compact: '[]',
    inserted_at: startedAt,
  };
}

function makeLossStreak(n: number, baseTime: number): MatchRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord(`prev-${i}`, 'loss', baseTime - (i + 1) * 3600_000),
  );
}

describe('lostrickDetector', () => {
  const NOW = 1700000000000;

  it('detects exactly a 9-loss streak', () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = makeLossStreak(8, NOW);
    const events = lostrickDetector.detect(record, prev);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('lostrick_9');
    expect(events[0]!.payload.streak).toBe(9);
  });

  it('does NOT emit for streak of 8', () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = makeLossStreak(7, NOW);
    expect(lostrickDetector.detect(record, prev)).toHaveLength(0);
  });

  it('does NOT emit for streak of 10 (single-emit policy)', () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = makeLossStreak(9, NOW);
    expect(lostrickDetector.detect(record, prev)).toHaveLength(0);
  });

  it('does NOT emit when current match is a win', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeLossStreak(9, NOW);
    expect(lostrickDetector.detect(record, prev)).toHaveLength(0);
  });

  it('breaks streak on draw', () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = [
      makeRecord('p1', 'loss', NOW - 1 * 3600_000),
      makeRecord('p2', 'loss', NOW - 2 * 3600_000),
      makeRecord('p3', 'draw', NOW - 3 * 3600_000), // draw breaks streak
      ...makeLossStreak(6, NOW - 4 * 3600_000),
    ];
    // streak is only 3 (current + p1 + p2)
    expect(lostrickDetector.detect(record, prev)).toHaveLength(0);
  });
});
