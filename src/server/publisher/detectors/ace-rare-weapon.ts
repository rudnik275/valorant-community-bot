import type { Detector, DetectedEvent, MatchRecord } from '../types.ts';
import { findAces } from './ace.ts';

/**
 * Rare weapons: Knife and Classic (starting pistol).
 * weapon strings match damage_weapon_id from Henrik API responses.
 * Canonical IDs are used as fallback; exact string depends on Henrik version.
 */
const RARE_WEAPONS = new Set([
  'Knife',
  'Classic',
  // Knife canonical ID from Henrik API
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7',
  // Classic canonical ID
  '29a0cfab-485b-f5d5-779a-b59f85e204a8',
]);

function isRareWeapon(weapon: string): boolean {
  return RARE_WEAPONS.has(weapon);
}

/**
 * Ace with a rare weapon detector: ace where ≥2 of the 5 kills used a rare weapon.
 * Triggered in addition to the regular `ace` event (separate DB row).
 *
 * If multiple qualifying aces are found, all are included in a single event
 * (same UNIQUE constraint reasoning as ace detector).
 */
export const aceRareWeaponDetector: Detector = {
  type: 'ace_rare_weapon_week',
  detect(record: MatchRecord, _prevRecords: MatchRecord[]): DetectedEvent[] {
    const aces = findAces(record);
    if (aces.length === 0) return [];

    const rareAces = aces.filter(
      (a) => a.weapons.filter((w) => isRareWeapon(w)).length >= 2,
    );

    if (rareAces.length === 0) return [];

    return [
      {
        type: 'ace_rare_weapon_week',
        riot_puuid: record.riot_puuid ?? '',
        match_id: record.match_id,
        payload: {
          rounds: rareAces.map((a) => a.round),
          weapons_per_round: rareAces.map((a) => a.weapons),
          rare_weapon_counts: rareAces.map(
            (a) => a.weapons.filter((w) => isRareWeapon(w)).length,
          ),
        },
      },
    ];
  },
};
