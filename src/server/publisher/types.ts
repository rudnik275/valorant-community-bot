import type { matchRecords } from '../db/schema/match_records.ts';
import type { InferSelectModel } from 'drizzle-orm';
import type { SqliteDb } from '../db/queries.ts';

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
  | 'record_longest_match_minutes'
  | 'record_survived_last_rounds'
  | 'record_died_first_rounds';

export interface DetectedEvent {
  type: EventType;
  riot_puuid: string;
  match_id: string;
  payload: Record<string, unknown>;
}

export interface DetectorDeps {
  /** Typed Drizzle handle. Detectors read via `db/queries.ts` named queries. */
  db: SqliteDb;
}

/**
 * Optional context passed to a detector's {@link Detector.enrich} step.
 * Mirrors the orchestrator's injectable deps so tests can stub Henrik /
 * region lookups without module-level mocks.
 */
export interface EnrichContext {
  db: SqliteDb;
  riot_puuid: string;
  match_id: string;
  /** Player region, resolved once by the orchestrator (null when unknown). */
  region: string | null;
  /**
   * Injectable opponent-peak fetcher. The orchestrator passes the real
   * `getOpponentPeakRanks` (or a test stub). Typed loosely so `types.ts`
   * doesn't import the Henrik/opponent-context layer.
   */
  getOpponentPeakRanksFn: (
    victims: Array<{ puuid: string; name: string; tag: string }>,
    region: string,
  ) => Promise<Map<string, { tier_id: number; tier_name: string; season_short: string }>>;
}

export interface Detector {
  type: EventType;
  /**
   * Single async detection method. The orchestrator ALWAYS supplies `deps`;
   * it is optional in the signature only so the formerly-sync detectors (and
   * their pure, db-less unit tests) can keep calling `detect(record, prev)`
   * with no `{ db }` ceremony. DB-backed detectors require it at runtime.
   * There is no longer a sync/async fork in the contract.
   */
  detect: (
    record: MatchRecord,
    prevRecords: MatchRecord[],
    deps?: DetectorDeps,
  ) => Promise<DetectedEvent[]>;
  /**
   * Optional post-detection enrichment, run by the orchestrator AFTER all
   * detectors produce events and BEFORE insert. The detector receives only
   * its OWN events and returns them (mutated/replaced). Keeps cross-cutting
   * augmentation (e.g. opponent-peak ranks for aces) behind the detector
   * seam instead of the orchestrator special-casing event types / payloads.
   */
  enrich?: (
    events: DetectedEvent[],
    ctx: EnrichContext,
  ) => Promise<DetectedEvent[]>;
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
  knife_kill: 'digest',
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
  record_survived_last_rounds: 'digest',
  record_died_first_rounds: 'digest',
  record_mvp_count_week: 'digest',
};

export function isRealtimeEvent(t: EventType): boolean {
  return EVENT_CATEGORY[t] === 'realtime';
}

export function isDigestEvent(t: EventType): boolean {
  return EVENT_CATEGORY[t] === 'digest';
}
