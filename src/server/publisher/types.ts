import type { matchRecords } from '../db/schema/match_records.ts';
import type { InferSelectModel } from 'drizzle-orm';

export type MatchRecord = InferSelectModel<typeof matchRecords>;

export type EventType =
  | 'ace'
  | 'ace_rare_weapon'
  | 'rank_promo'
  | 'winstreak_9'
  | 'giant_slayer'
  | 'return_after_pause'
  | 'teamkill'
  | 'fall_damage_death'
  | 'record_kills_match'
  | 'knife_kill';

export interface DetectedEvent {
  type: EventType;
  riot_puuid: string;
  match_id: string;
  payload: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DetectorDeps {
  db: any;
}

export interface Detector {
  type: EventType;
  detect: (record: MatchRecord, prevRecords: MatchRecord[]) => DetectedEvent[];
  /** Optional async alternative — used by detectors that need DB access (e.g. record detectors). */
  detectAsync?: (record: MatchRecord, prevRecords: MatchRecord[], deps: DetectorDeps) => Promise<DetectedEvent[]>;
}
