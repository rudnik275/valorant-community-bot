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
  | 'fall_damage_death';

export interface DetectedEvent {
  type: EventType;
  riot_puuid: string;
  match_id: string;
  payload: Record<string, unknown>;
}

export interface Detector {
  type: EventType;
  detect: (record: MatchRecord, prevRecords: MatchRecord[]) => DetectedEvent[];
}
