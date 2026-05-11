/**
 * decide.ts — Pure decision function for publisher logic.
 *
 * Determines whether a pending event should be posted or skipped
 * based on opt-out status and publishing period.
 *
 * All checks are pure — no side effects, no I/O. Fully unit-testable.
 */

import type { EventType } from './types.ts';

export interface DecideContext {
  event: {
    event_type: EventType;
    riot_puuid: string;
  };
  /** Whether the user has opted out of real-time chat notifications. */
  is_opted_out: boolean;
  /** Whether the publishing period has started (EVENTS_PUBLISHING_ENABLED_AFTER). */
  events_publishing_enabled: boolean;
}

export type Decision = 'post' | 'silent' | 'opted-out';

/**
 * Decide what to do with a pending event.
 *
 * Order of checks:
 * 1. !events_publishing_enabled → 'silent'
 * 2. is_opted_out → 'opted-out'
 * 3. else → 'post'
 */
export function decide(ctx: DecideContext): Decision {
  if (!ctx.events_publishing_enabled) {
    return 'silent';
  }

  if (ctx.is_opted_out) {
    return 'opted-out';
  }

  return 'post';
}
