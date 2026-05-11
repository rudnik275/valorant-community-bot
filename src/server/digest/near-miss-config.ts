/**
 * near-miss-config.ts — Thresholds for "Был близок к рекорду" digest section.
 *
 * For each all-time record type, defines how close a week's best result
 * must be to the current record to qualify as a near-miss.
 * Near-misses are purely a digest-render computation — no DB writes.
 */

export interface NearMissThreshold {
  recordType: string;
  /** absolute delta — value within this distance below all-time record counts as near-miss */
  threshold: number;
  /** column name in match_records (or special value for derived columns) */
  source: 'kills' | 'deaths' | 'headshots' | 'legshots' | 'damage_dealt' | 'damage_received' | 'game_length_minutes' | 'rounds_played';
  emoji: string;
  caption: string;  // e.g., 'киллам в матче'
  unit: string;     // e.g., 'фрагов'
}

export const NEAR_MISS_THRESHOLDS: NearMissThreshold[] = [
  { recordType: 'kills_match', threshold: 2, source: 'kills', emoji: '💀', caption: 'киллам в матче', unit: 'фрагов' },
  { recordType: 'deaths_match', threshold: 2, source: 'deaths', emoji: '🩸', caption: 'смертям в матче', unit: 'смертей' },
  { recordType: 'headshots_match', threshold: 2, source: 'headshots', emoji: '🤠', caption: 'хедшотам', unit: 'хедшотов' },
  { recordType: 'legshots_match', threshold: 2, source: 'legshots', emoji: '♿️', caption: 'легшотам', unit: 'легшотов' },
  { recordType: 'damage_dealt_match', threshold: 1000, source: 'damage_dealt', emoji: '🥩', caption: 'урону', unit: 'dmg' },
  { recordType: 'damage_received_match', threshold: 1000, source: 'damage_received', emoji: '😵', caption: 'полученному урону', unit: 'dmg' },
  { recordType: 'longest_match_minutes', threshold: 2, source: 'game_length_minutes', emoji: '⏱', caption: 'длительности матча', unit: 'минут' },
  { recordType: 'longest_match_rounds', threshold: 2, source: 'rounds_played', emoji: '😰', caption: 'раундам в матче', unit: 'раундов' },
  // kills_per_weapon excluded — too many sub-types, low signal-to-noise
];
