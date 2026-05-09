/**
 * decide.ts — Pure decision function for publisher anti-spam logic.
 *
 * Determines whether a pending event should be posted, silenced, deferred,
 * or routed to digest based on quotas, quiet-hours, and opt-out status.
 *
 * All checks are pure — no side effects, no I/O. Fully unit-testable.
 */

import type { EventType } from './types.ts';

export const ANTISTAT_TYPES: ReadonlySet<EventType> = new Set([
  'lostrick_9',
  'teamkill',
  'fall_damage_death',
  'zero_match',
] as EventType[]);

export interface DecideContext {
  event: {
    event_type: EventType;
    riot_puuid: string;
  };
  /** Number of events posted today (chat-wide). */
  today_chat_count: number;
  /** Number of events posted today for THIS riot_puuid. */
  today_user_count: number;
  /** Number of antistat events posted today (chat-wide). */
  today_antistat_count: number;
  /** Whether the user has opted out of real-time chat notifications. */
  is_opted_out: boolean;
  /** Whether the publishing period has started (EVENTS_PUBLISHING_ENABLED_AFTER). */
  events_publishing_enabled: boolean;
  /** Whether it's before 12:00 Kyiv time (quiet hours). */
  in_quiet_hours: boolean;
}

export type Decision = 'post' | 'digest-only' | 'silent' | 'opted-out' | 'defer';

/**
 * Decide what to do with a pending event.
 *
 * Order of checks (per spec):
 * 1. !events_publishing_enabled → 'silent'
 * 2. in_quiet_hours → 'defer' (don't update status; try again next tick)
 * 3. is_opted_out → 'opted-out'
 * 4. today_chat_count >= 2 → 'digest-only'
 * 5. today_user_count >= 1 → 'digest-only'
 * 6. is_antistat AND today_antistat_count >= 1 → 'digest-only'
 * 7. else → 'post'
 */
export function decide(ctx: DecideContext): Decision {
  if (!ctx.events_publishing_enabled) {
    return 'silent';
  }

  if (ctx.in_quiet_hours) {
    return 'defer';
  }

  if (ctx.is_opted_out) {
    return 'opted-out';
  }

  if (ctx.today_chat_count >= 2) {
    return 'digest-only';
  }

  if (ctx.today_user_count >= 1) {
    return 'digest-only';
  }

  const is_antistat = ANTISTAT_TYPES.has(ctx.event.event_type);
  if (is_antistat && ctx.today_antistat_count >= 1) {
    return 'digest-only';
  }

  return 'post';
}
