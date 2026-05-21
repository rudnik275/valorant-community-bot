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
  source: 'kills' | 'deaths' | 'headshots' | 'legshots' | 'damage_dealt' | 'damage_received' | 'game_length_minutes' | 'rounds_played' | 'died_first_rounds' | 'mvp_count_week';
  emoji: string;
  /** full funny header text (without emoji prefix and without trailing whitespace) */
  header: string;
  unit: string;     // e.g., 'фрагов'
  /** minimum weekly value required to qualify as near-miss (suppresses trivial near-misses) */
  floor?: number;
}

export const NEAR_MISS_THRESHOLDS: NearMissThreshold[] = [
  { recordType: 'kills_match',           threshold: 2,    source: 'kills',                emoji: '💀', header: 'Был(ла) близко к рекорду по киллам',                                  unit: 'фрагов'   },
  { recordType: 'deaths_match',          threshold: 2,    source: 'deaths',               emoji: '⚰️', header: 'Был(ла) близко к тому чтоб стать новой жертвой насилия',              unit: 'смертей'  },
  { recordType: 'headshots_match',       threshold: 2,    source: 'headshots',            emoji: '🤠', header: 'Чуть не разорвал(а) рекорд по попаданиям в голову',                  unit: 'попаданий' },
  { recordType: 'legshots_match',        threshold: 2,    source: 'legshots',             emoji: '♿️', header: 'Был(а) близок(ка) к рекорду по попаданиям в ноги',                    unit: 'попаданий' },
  { recordType: 'damage_dealt_match',    threshold: 1000, source: 'damage_dealt',         emoji: '🥩', header: 'Был(ла) близко к тому чтоб стать мясником недели',                    unit: 'dmg'      },
  { recordType: 'damage_received_match', threshold: 1000, source: 'damage_received',      emoji: '🤕', header: 'Был(а) близок(ка) к рекорду по полученному урону',                    unit: 'dmg'      },
  { recordType: 'longest_match_minutes', threshold: 2,    source: 'game_length_minutes',  emoji: '⏳', header: 'Близко к самому длинному матчу по минутам',                           unit: 'минут'    },
  // kills_per_weapon excluded — too many sub-types, low signal-to-noise
  { recordType: 'died_first_rounds_match', threshold: 1, source: 'died_first_rounds', emoji: '🐴', header: 'Чуть не стал(а) троянским конём недели', unit: 'первых смертей' },
  { recordType: 'mvp_count_week', threshold: 2, source: 'mvp_count_week', emoji: '👑', header: 'Был(а) близок(ка) к тому чтобы стать королём MVP за неделю', unit: 'MVP-матчей', floor: 10 },
];
