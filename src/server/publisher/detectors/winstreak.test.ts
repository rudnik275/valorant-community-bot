import { describe, it, expect } from 'vitest';
import { winstreakDetector } from './winstreak.ts';
import type { MatchRecord } from '../types.ts';

function makeRecord(matchId: string, result: 'win' | 'loss' | 'draw', startedAt: number): MatchRecord {
  return {
    riot_puuid: 'puuid-1',
    match_id: matchId,
    started_at: startedAt,
    map: 'Ascent',
    agent: 'Jett',
    kills: 10,
    deaths: 5,
    assists: 2,
    result,
    rounds_played: 25,
    rank_before: null,
    rank_after: 'Diamond 1',
    enemy_avg_rank: 'Diamond 1',
    fall_damage_kills: 0,
    kill_events_compact: '[]',
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
    inserted_at: startedAt,
  };
}

/** Creates N previous win records in desc order */
function makeWinStreak(n: number, baseTime: number): MatchRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord(`prev-${i}`, 'win', baseTime - (i + 1) * 3600_000),
  );
}

describe('winstreakDetector', () => {
  const NOW = 1700000000000;

  it('detects exactly a 9-win streak', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(8, NOW); // 8 previous wins + current = 9
    const events = winstreakDetector.detect(record, prev);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('winstreak_9');
    expect(events[0]!.payload.streak).toBe(9);
  });

  it('does NOT emit for streak of 8', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(7, NOW); // 7 previous wins + current = 8
    expect(winstreakDetector.detect(record, prev)).toHaveLength(0);
  });

  it('does NOT emit for streak of 10 (single-emit policy)', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(9, NOW); // 9 previous wins + current = 10
    expect(winstreakDetector.detect(record, prev)).toHaveLength(0);
  });

  it('does NOT emit when current match is a loss', () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = makeWinStreak(9, NOW);
    expect(winstreakDetector.detect(record, prev)).toHaveLength(0);
  });

  it('breaks streak on draw', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = [
      makeRecord('p1', 'win', NOW - 1 * 3600_000),
      makeRecord('p2', 'win', NOW - 2 * 3600_000),
      makeRecord('p3', 'draw', NOW - 3 * 3600_000), // draw breaks streak
      ...makeWinStreak(6, NOW - 4 * 3600_000),
    ];
    // streak is only 3 (current + p1 + p2)
    expect(winstreakDetector.detect(record, prev)).toHaveLength(0);
  });

  it('includes started_match_id in payload', () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(8, NOW);
    const events = winstreakDetector.detect(record, prev);
    expect(events[0]!.payload.started_match_id).toBeTruthy();
  });
});
