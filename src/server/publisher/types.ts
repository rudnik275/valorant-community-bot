import type { matchRecords } from '../db/schema/match_records.ts';
import type { InferSelectModel } from 'drizzle-orm';

export type MatchRecord = InferSelectModel<typeof matchRecords>;

export type EventType =
  | 'ace'
  | 'peak_rank_up'
  | 'winstreak_10plus'
  | 'giant_slayer'
  | 'return_after_pause'
  | 'teamkill'
  | 'fall_damage_death'
  | 'record_kills_match'
  | 'record_damage_dealt_match'
  | 'record_damage_received_match'
  | 'record_deaths_match'
  | 'record_headshots_match'
  | 'record_legshots_match'
  | 'knife_kill'
  | 'match_comeback'
  | 'record_mvp_count_week'
  | 'community_clash'
  | 'record_kills_per_weapon'
  | 'record_longest_match_minutes';

export interface DetectedEvent {
  type: EventType;
  riot_puuid: string;
  match_id: string;
  payload: Record<string, unknown>;
}

export interface DetectorDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

export interface Detector {
  type: EventType;
  detect: (record: MatchRecord, prevRecords: MatchRecord[]) => DetectedEvent[];
  /** Optional async alternative — used by detectors that need DB access (e.g. record detectors). */
  detectAsync?: (record: MatchRecord, prevRecords: MatchRecord[], deps: DetectorDeps) => Promise<DetectedEvent[]>;
}

export type EventCategory = 'realtime' | 'digest';

/**
 * Source of truth: each EventType belongs to exactly ONE category.
 * Realtime events fire immediately via publisher loop and NEVER appear in digest.
 * Digest events appear ONLY in the Friday weekly digest and NEVER fire as realtime notifications.
 */
export const EVENT_CATEGORY: Record<EventType, EventCategory> = {
  giant_slayer: 'realtime',
  teamkill: 'realtime',
  fall_damage_death: 'realtime',
  knife_kill: 'realtime',
  match_comeback: 'realtime',
  community_clash: 'realtime',
  return_after_pause: 'realtime',

  ace: 'digest',
  winstreak_10plus: 'digest',
  peak_rank_up: 'digest',
  record_kills_match: 'digest',
  record_deaths_match: 'digest',
  record_headshots_match: 'digest',
  record_legshots_match: 'digest',
  record_damage_dealt_match: 'digest',
  record_damage_received_match: 'digest',
  record_kills_per_weapon: 'digest',
  record_longest_match_minutes: 'digest',
  record_mvp_count_week: 'digest',
};

export function isRealtimeEvent(t: EventType): boolean {
  return EVENT_CATEGORY[t] === 'realtime';
}

export function isDigestEvent(t: EventType): boolean {
  return EVENT_CATEGORY[t] === 'digest';
}
