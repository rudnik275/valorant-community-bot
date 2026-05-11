import type { matchRecords } from '../db/schema/match_records.ts';
import type { InferSelectModel } from 'drizzle-orm';

export type MatchRecord = InferSelectModel<typeof matchRecords>;

export type EventType =
  | 'ace'
  | 'ace_rare_weapon_week'
  | 'rank_promo'
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
  | 'record_longest_match_rounds';

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
