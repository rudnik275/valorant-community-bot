import { describe, it, expect } from 'vitest';
import { EVENT_CATEGORY, isRealtimeEvent, isWeeklyEvent, type EventType } from './types.ts';

describe('EVENT_CATEGORY', () => {
  it('covers all 20 EventType values exactly once', () => {
    const allEvents: EventType[] = [
      'ace',
      'giant_slayer',
      'teamkill',
      'knife_kill',
      'match_comeback',
      'community_clash',
      'return_after_pause',
      'winstreak_10plus',
      'peak_rank_up',
      'record_kills_match',
      'record_deaths_match',
      'record_headshots_match',
      'record_legshots_match',
      'record_damage_dealt_match',
      'record_damage_received_match',
      'record_kills_per_weapon',
      'record_longest_match_minutes',
      'record_survived_last_rounds',
      'record_died_first_rounds',
      'record_mvp_count_week',
    ];
    expect(Object.keys(EVENT_CATEGORY).sort()).toEqual([...allEvents].sort());
  });

  it('has 5 realtime types', () => {
    const realtime = Object.entries(EVENT_CATEGORY)
      .filter(([, v]) => v === 'realtime')
      .map(([k]) => k);
    expect(realtime.sort()).toEqual([
      'community_clash',
      'giant_slayer',
      'match_comeback',
      'return_after_pause',
      'teamkill',
    ]);
  });

  it('has 15 weekly types — ace/knife_kill moved here when the daily digest was dropped', () => {
    const weekly = Object.entries(EVENT_CATEGORY)
      .filter(([, v]) => v === 'weekly')
      .map(([k]) => k);
    expect(weekly.length).toBe(15);
    expect(weekly.sort()).toEqual([
      'ace',
      'knife_kill',
      'peak_rank_up',
      'record_damage_dealt_match',
      'record_damage_received_match',
      'record_deaths_match',
      'record_died_first_rounds',
      'record_headshots_match',
      'record_kills_match',
      'record_kills_per_weapon',
      'record_legshots_match',
      'record_longest_match_minutes',
      'record_mvp_count_week',
      'record_survived_last_rounds',
      'winstreak_10plus',
    ]);
  });

  it('every value is "realtime" or "weekly" — there is no "daily" category any more', () => {
    for (const v of Object.values(EVENT_CATEGORY)) {
      expect(['realtime', 'weekly']).toContain(v);
    }
  });
});

describe('isRealtimeEvent / isWeeklyEvent', () => {
  it('isRealtimeEvent returns true for realtime types', () => {
    expect(isRealtimeEvent('teamkill')).toBe(true);
    expect(isRealtimeEvent('return_after_pause')).toBe(true);
    expect(isRealtimeEvent('giant_slayer')).toBe(true);
  });

  it('isRealtimeEvent returns false for weekly types', () => {
    expect(isRealtimeEvent('ace')).toBe(false);
    expect(isRealtimeEvent('knife_kill')).toBe(false);
    expect(isRealtimeEvent('winstreak_10plus')).toBe(false);
    expect(isRealtimeEvent('peak_rank_up')).toBe(false);
    expect(isRealtimeEvent('record_kills_match')).toBe(false);
  });

  it('isWeeklyEvent returns true for weekly types', () => {
    expect(isWeeklyEvent('winstreak_10plus')).toBe(true);
    expect(isWeeklyEvent('peak_rank_up')).toBe(true);
    expect(isWeeklyEvent('record_kills_match')).toBe(true);
  });

  it('isWeeklyEvent returns false for realtime types', () => {
    expect(isWeeklyEvent('teamkill')).toBe(false);
    expect(isWeeklyEvent('giant_slayer')).toBe(false);
  });

  it('ace and knife_kill are weekly, not realtime — they feed the weekly leaderboards', () => {
    expect(isWeeklyEvent('ace')).toBe(true);
    expect(isWeeklyEvent('knife_kill')).toBe(true);
    expect(isRealtimeEvent('ace')).toBe(false);
    expect(isRealtimeEvent('knife_kill')).toBe(false);
  });

  it('every EventType is exactly one of realtime or weekly', () => {
    for (const k of Object.keys(EVENT_CATEGORY) as EventType[]) {
      const r = isRealtimeEvent(k);
      const w = isWeeklyEvent(k);
      expect([r, w].filter(Boolean).length).toBe(1);
    }
  });
});
