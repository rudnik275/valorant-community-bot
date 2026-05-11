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

// Map canonical UUIDs to display names (best-effort; raw weapon string is used as fallback).
const WEAPON_NAME: Record<string, string> = {
  '4ade7faa-4cf1-8376-95ef-39884480959b': 'Operator',
  '910be174-449b-a89f-1c5d-ffa1a8c3d6c2': 'Marshal',
  '29a0cfab-485b-f5d5-779a-b59f85e204a8': 'Classic',
  '42da8ccc-40d5-affc-beec-15522c2d502d': 'Shorty',
  '44d4e95c-4157-0037-81b2-17841bf2e8e9': 'Frenzy',
  'a03b24d3-4319-996d-0f8c-94bbfba1dfc7': 'Ghost',
  '1baa85b4-4c70-1284-64bb-8481d58f4d8d': 'Sheriff',
  'f7e1b454-50c7-a545-a891-f5c154926dda': 'Stinger',
  '462080d1-4035-2937-7c09-27aa2a5c27a7': 'Spectre',
  'ec845bf4-4f79-ddda-a3da-0db3d5fb9896': 'Bucky',
  '63e6c2b6-4a8e-869c-3d4c-e38355226584': 'Ares',
  '55d8a0f4-4274-ca67-fe2c-06ab45efdf58': 'Odin',
  '2f59173c-4bed-b6c3-2191-dea9b58be9c7': 'Knife',
};

function canonicalWeapon(raw: string): string {
  return WEAPON_NAME[raw] ?? raw; // pass through name if it's already a name
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

    // Group kills by weapon, attacker = this community player
    const byWeapon = new Map<string, number>();
    for (const k of kills) {
      if (k.attacker_puuid !== puuid) continue;
      if (EXCLUDED.has(k.weapon)) continue;
      const w = canonicalWeapon(k.weapon);
      byWeapon.set(w, (byWeapon.get(w) ?? 0) + 1);
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
