import { describe, it, expect } from 'vitest';
import { decide } from './decide.ts';
import type { DecideContext, Decision } from './decide.ts';
import type { EventType } from './types.ts';

const STAT_TYPE: EventType = 'ace';

function makeCtx(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    event: { event_type: STAT_TYPE, riot_puuid: 'puuid-1' },
    is_opted_out: false,
    events_publishing_enabled: true,
    ...overrides,
  };
}

describe('decide()', () => {
  describe('events_publishing_enabled = false → silent', () => {
    it('returns silent regardless of other params', () => {
      const cases: Partial<DecideContext>[] = [
        { events_publishing_enabled: false },
        { events_publishing_enabled: false, is_opted_out: true },
        { events_publishing_enabled: false, is_opted_out: false },
      ];
      for (const override of cases) {
        expect(decide(makeCtx(override))).toBe('silent' satisfies Decision);
      }
    });
  });

  describe('is_opted_out = true → opted-out', () => {
    it('returns opted-out when user is opted out', () => {
      expect(decide(makeCtx({ is_opted_out: true }))).toBe('opted-out' satisfies Decision);
    });

    it('opted-out check happens after publishing_enabled check', () => {
      // publishing disabled takes priority over opted-out
      expect(decide(makeCtx({ events_publishing_enabled: false, is_opted_out: true }))).toBe('silent');
    });
  });

  describe('happy path → post', () => {
    it('returns post when all conditions clear', () => {
      expect(decide(makeCtx())).toBe('post' satisfies Decision);
    });

    it('returns post for any event type when not opted out', () => {
      const types: EventType[] = ['ace', 'ace_rare_weapon_week', 'rank_promo', 'winstreak_10plus', 'giant_slayer', 'return_after_pause', 'teamkill', 'fall_damage_death'];
      for (const eventType of types) {
        expect(decide(makeCtx({ event: { event_type: eventType, riot_puuid: 'puuid-1' } }))).toBe('post');
      }
    });
  });

  describe('priority order matrix', () => {
    it('silent > opted-out > post', () => {
      expect(decide(makeCtx({
        events_publishing_enabled: false,
        is_opted_out: true,
      }))).toBe('silent');
    });

    it('opted-out > post', () => {
      expect(decide(makeCtx({
        is_opted_out: true,
      }))).toBe('opted-out');
    });
  });
});
