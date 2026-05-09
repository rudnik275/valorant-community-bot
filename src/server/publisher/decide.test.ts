import { describe, it, expect } from 'vitest';
import { decide, ANTISTAT_TYPES } from './decide.ts';
import type { DecideContext, Decision } from './decide.ts';
import type { EventType } from './types.ts';

const STAT_TYPE: EventType = 'ace';
const ANTISTAT_TYPE: EventType = 'lostrick_9';

function makeCtx(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    event: { event_type: STAT_TYPE, riot_puuid: 'puuid-1' },
    today_chat_count: 0,
    today_user_count: 0,
    today_antistat_count: 0,
    is_opted_out: false,
    events_publishing_enabled: true,
    in_quiet_hours: false,
    ...overrides,
  };
}

describe('decide()', () => {
  describe('ANTISTAT_TYPES', () => {
    it('contains lostrick_9, teamkill, fall_damage_death, zero_match', () => {
      expect(ANTISTAT_TYPES.has('lostrick_9')).toBe(true);
      expect(ANTISTAT_TYPES.has('teamkill')).toBe(true);
      expect(ANTISTAT_TYPES.has('fall_damage_death')).toBe(true);
      expect(ANTISTAT_TYPES.has('zero_match')).toBe(true);
    });

    it('does NOT contain stat types', () => {
      expect(ANTISTAT_TYPES.has('ace')).toBe(false);
      expect(ANTISTAT_TYPES.has('winstreak_9')).toBe(false);
      expect(ANTISTAT_TYPES.has('rank_promo')).toBe(false);
      expect(ANTISTAT_TYPES.has('giant_slayer')).toBe(false);
    });
  });

  describe('events_publishing_enabled = false → silent', () => {
    it('returns silent regardless of other params', () => {
      const cases: Partial<DecideContext>[] = [
        { events_publishing_enabled: false },
        { events_publishing_enabled: false, in_quiet_hours: true },
        { events_publishing_enabled: false, is_opted_out: true },
        { events_publishing_enabled: false, today_chat_count: 0 },
      ];
      for (const override of cases) {
        expect(decide(makeCtx(override))).toBe('silent' satisfies Decision);
      }
    });
  });

  describe('in_quiet_hours = true → defer', () => {
    it('returns defer when publishing enabled but in quiet hours', () => {
      expect(decide(makeCtx({ in_quiet_hours: true }))).toBe('defer' satisfies Decision);
    });

    it('quiet_hours check happens after publishing_enabled check', () => {
      // publishing disabled takes priority over quiet_hours
      expect(decide(makeCtx({ events_publishing_enabled: false, in_quiet_hours: true }))).toBe('silent');
    });
  });

  describe('is_opted_out = true → opted-out', () => {
    it('returns opted-out when user is opted out', () => {
      expect(decide(makeCtx({ is_opted_out: true }))).toBe('opted-out' satisfies Decision);
    });

    it('opted-out check happens after quiet_hours check', () => {
      // quiet_hours takes priority over opted-out
      expect(decide(makeCtx({ in_quiet_hours: true, is_opted_out: true }))).toBe('defer');
    });
  });

  describe('today_chat_count >= 2 → digest-only', () => {
    it('returns digest-only when chat count is exactly 2', () => {
      expect(decide(makeCtx({ today_chat_count: 2 }))).toBe('digest-only' satisfies Decision);
    });

    it('returns digest-only when chat count exceeds 2', () => {
      expect(decide(makeCtx({ today_chat_count: 5 }))).toBe('digest-only');
    });

    it('returns post when chat count is 1', () => {
      expect(decide(makeCtx({ today_chat_count: 1 }))).toBe('post' satisfies Decision);
    });

    it('chat_count check happens after opted-out check', () => {
      // opted-out takes priority over chat_count
      expect(decide(makeCtx({ is_opted_out: true, today_chat_count: 0 }))).toBe('opted-out');
    });
  });

  describe('today_user_count >= 1 → digest-only', () => {
    it('returns digest-only when user count is exactly 1', () => {
      expect(decide(makeCtx({ today_user_count: 1 }))).toBe('digest-only');
    });

    it('returns digest-only when user count exceeds 1', () => {
      expect(decide(makeCtx({ today_user_count: 3 }))).toBe('digest-only');
    });

    it('returns post when user count is 0 and chat count < 2', () => {
      expect(decide(makeCtx({ today_user_count: 0, today_chat_count: 1 }))).toBe('post');
    });

    it('user_count check happens after chat_count check', () => {
      // chat_count >= 2 takes priority over user_count
      expect(decide(makeCtx({ today_chat_count: 2, today_user_count: 0 }))).toBe('digest-only');
    });
  });

  describe('antistat + today_antistat_count >= 1 → digest-only', () => {
    it('returns digest-only when antistat event and one already posted', () => {
      expect(decide(makeCtx({
        event: { event_type: ANTISTAT_TYPE, riot_puuid: 'puuid-1' },
        today_antistat_count: 1,
      }))).toBe('digest-only');
    });

    it('returns post when antistat event but none posted yet', () => {
      expect(decide(makeCtx({
        event: { event_type: ANTISTAT_TYPE, riot_puuid: 'puuid-1' },
        today_antistat_count: 0,
      }))).toBe('post');
    });

    it('returns post when stat type (non-antistat) even with antistat_count = 1', () => {
      expect(decide(makeCtx({
        event: { event_type: STAT_TYPE, riot_puuid: 'puuid-1' },
        today_antistat_count: 1,
      }))).toBe('post');
    });

    it('antistat check after user_count check', () => {
      // user_count >= 1 takes priority over antistat
      expect(decide(makeCtx({
        event: { event_type: ANTISTAT_TYPE, riot_puuid: 'puuid-1' },
        today_user_count: 1,
        today_antistat_count: 0,
      }))).toBe('digest-only');
    });
  });

  describe('all antistat types trigger digest when count >= 1', () => {
    for (const eventType of ['lostrick_9', 'teamkill', 'fall_damage_death', 'zero_match'] as EventType[]) {
      it(`${eventType} returns digest-only when antistat_count=1`, () => {
        expect(decide(makeCtx({
          event: { event_type: eventType, riot_puuid: 'puuid-1' },
          today_antistat_count: 1,
        }))).toBe('digest-only');
      });
    }
  });

  describe('happy path → post', () => {
    it('returns post when all conditions clear', () => {
      expect(decide(makeCtx())).toBe('post');
    });

    it('returns post with chat_count=1, user_count=0, antistat_count=0, non-antistat event', () => {
      expect(decide(makeCtx({ today_chat_count: 1 }))).toBe('post');
    });

    it('returns post for first antistat event of the day', () => {
      expect(decide(makeCtx({
        event: { event_type: 'fall_damage_death', riot_puuid: 'puuid-1' },
        today_antistat_count: 0,
      }))).toBe('post');
    });
  });

  describe('priority order matrix', () => {
    it('silent > defer > opted-out > digest > post', () => {
      // Test the full stack with most restrictive conditions
      expect(decide(makeCtx({
        events_publishing_enabled: false,
        in_quiet_hours: true,
        is_opted_out: true,
        today_chat_count: 5,
      }))).toBe('silent');
    });

    it('defer > opted-out > digest > post', () => {
      expect(decide(makeCtx({
        in_quiet_hours: true,
        is_opted_out: true,
        today_chat_count: 5,
      }))).toBe('defer');
    });

    it('opted-out > digest > post', () => {
      expect(decide(makeCtx({
        is_opted_out: true,
        today_chat_count: 5,
      }))).toBe('opted-out');
    });
  });
});
