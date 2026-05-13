import { describe, it, expect } from 'vitest';
import { EVENT_CATEGORY, isRealtimeEvent, isDigestEvent, type EventType } from './types.ts';

describe('EVENT_CATEGORY', () => {
  it('covers all 21 EventType values exactly once', () => {
    const allEvents: EventType[] = [
      'ace',
      'giant_slayer',
      'teamkill',
      'fall_damage_death',
      'knife_kill',
      'match_comeback',
      'community_clash',
      'return_after_pause',
      'ace_rare_weapon_week',
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
      'record_mvp_count_week',
    ];
    expect(Object.keys(EVENT_CATEGORY).sort()).toEqual([...allEvents].sort());
  });

  it('has 8 realtime types', () => {
    const realtime = Object.entries(EVENT_CATEGORY)
      .filter(([, v]) => v === 'realtime')
      .map(([k]) => k);
    expect(realtime.sort()).toEqual([
      'ace',
      'community_clash',
      'fall_damage_death',
      'giant_slayer',
      'knife_kill',
      'match_comeback',
      'return_after_pause',
      'teamkill',
    ]);
  });

  it('has 12 digest types', () => {
    const digest = Object.entries(EVENT_CATEGORY)
      .filter(([, v]) => v === 'digest')
      .map(([k]) => k);
    expect(digest.length).toBe(12);
    expect(digest.sort()).toEqual([
      'ace_rare_weapon_week',
      'peak_rank_up',
      'record_damage_dealt_match',
      'record_damage_received_match',
      'record_deaths_match',
      'record_headshots_match',
      'record_kills_match',
      'record_kills_per_weapon',
      'record_legshots_match',
      'record_longest_match_minutes',
      'record_mvp_count_week',
      'winstreak_10plus',
    ]);
  });

  it('every value is either "realtime" or "digest"', () => {
    for (const v of Object.values(EVENT_CATEGORY)) {
      expect(['realtime', 'digest']).toContain(v);
    }
  });
});

describe('isRealtimeEvent / isDigestEvent', () => {
  it('isRealtimeEvent returns true for realtime types', () => {
    expect(isRealtimeEvent('ace')).toBe(true);
    expect(isRealtimeEvent('teamkill')).toBe(true);
    expect(isRealtimeEvent('return_after_pause')).toBe(true);
  });

  it('isRealtimeEvent returns false for digest types', () => {
    expect(isRealtimeEvent('winstreak_10plus')).toBe(false);
    expect(isRealtimeEvent('peak_rank_up')).toBe(false);
    expect(isRealtimeEvent('record_kills_match')).toBe(false);
  });

  it('isDigestEvent returns true for digest types', () => {
    expect(isDigestEvent('winstreak_10plus')).toBe(true);
    expect(isDigestEvent('peak_rank_up')).toBe(true);
    expect(isDigestEvent('ace_rare_weapon_week')).toBe(true);
  });

  it('isDigestEvent returns false for realtime types', () => {
    expect(isDigestEvent('ace')).toBe(false);
    expect(isDigestEvent('teamkill')).toBe(false);
  });

  it('every EventType is exactly one of realtime or digest', () => {
    for (const k of Object.keys(EVENT_CATEGORY) as EventType[]) {
      const r = isRealtimeEvent(k);
      const d = isDigestEvent(k);
      expect(r !== d).toBe(true);
    }
  });
});
