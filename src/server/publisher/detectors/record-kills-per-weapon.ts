import { eq } from 'drizzle-orm';
import type { Detector, DetectedEvent, DetectorDeps, MatchRecord } from '../types.ts';
import { upsertRecord } from '../record-tracker.ts';
import { users } from '../../db/schema/users.ts';

interface KillEvent {
  round: number;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
  attacker_team: string;
  victim_team: string;
}

// Weapons to ignore: Vandal/Phantom (too dominant), Knife/Fall (handled by other detectors).
// Canonical UUIDs included (Henrik may return either form).
const EXCLUDED = new Set([
  'Vandal',
  'Phantom',
  'Knife',
  'Fall',
  '9c82e19d-4575-0200-1a81-3eacf00cf872', // Vandal
  'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', // Phantom
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7', // Knife
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return true if the raw weapon string is usable as a human-readable label.
 * Henrik returns `weapon.name` for known weapons but sometimes only ships the
 * UUID; we don't keep a UUID→name map (the previous one had several wrong
 * entries — see fixture: a03b24d3… is Operator, not Ghost). Anything that
 * looks like a UUID or is empty is dropped — it would render as
 * "Эксперт по 39099fb5-…" in the digest, which is just noise.
 */
function isUsableWeaponName(raw: string): boolean {
  if (!raw) return false;
  if (UUID_PATTERN.test(raw)) return false;
  return true;
}

export const recordKillsPerWeaponDetector: Detector = {
  type: 'record_kills_per_weapon',
  detect: () => [], // not used — async path only
  detectAsync: async (record: MatchRecord, _prev: MatchRecord[], deps: DetectorDeps): Promise<DetectedEvent[]> => {
    const puuid = record.riot_puuid ?? '';
    if (!puuid) return [];

    let kills: KillEvent[];
    try {
      kills = JSON.parse(record.kill_events_compact) as KillEvent[];
    } catch {
      return [];
    }
    if (kills.length === 0) return [];

    // Group kills by weapon, attacker = this community player.
    // Skip empty weapon strings and raw UUIDs — those can't be rendered
    // meaningfully in the digest.
    const byWeapon = new Map<string, number>();
    for (const k of kills) {
      if (k.attacker_puuid !== puuid) continue;
      if (EXCLUDED.has(k.weapon)) continue;
      if (!isUsableWeaponName(k.weapon)) continue;
      byWeapon.set(k.weapon, (byWeapon.get(k.weapon) ?? 0) + 1);
    }
    if (byWeapon.size === 0) return [];

    const events: DetectedEvent[] = [];
    for (const [weapon, count] of byWeapon) {
      const result = await upsertRecord(deps.db, {
        recordType: 'kills_per_weapon',
        weapon,
        value: count,
        riotPuuid: puuid,
        matchId: record.match_id,
        achievedAt: record.started_at,
      });

      // Only emit if NEW > OLD AND OLD > 0 (skip first-time weapon records to avoid flood)
      if (!result.beaten) continue;
      if (!result.prev || result.prev.value <= 0) continue;

      let prevName = '';
      let prevTag = '';
      const [u] = await deps.db
        .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
        .from(users)
        .where(eq(users.riot_puuid, result.prev.puuid))
        .limit(1);
      prevName = u?.riot_name ?? '';
      prevTag = u?.riot_tag ?? '';

      // UNIQUE constraint on detected_events is (match_id, event_type, riot_puuid).
      // Per-weapon events from the same match would collide after the first insert.
      // Solution: embed weapon name into match_id for the event row so each weapon
      // gets a distinct dedup key. The real match_id is kept in payload for tracker links.
      events.push({
        type: 'record_kills_per_weapon',
        riot_puuid: puuid,
        match_id: `${record.match_id}#kpw-${weapon}`,
        payload: {
          weapon,
          value: count,
          prev_value: result.prev.value,
          prev_puuid: result.prev.puuid,
          prev_name: prevName,
          prev_tag: prevTag,
          real_match_id: record.match_id,
        },
      });
    }
    return events;
  },
};
