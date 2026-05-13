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

/**
 * Whitelist of canonical Valorant weapons that count for "Эксперт по …" records.
 *
 * Henrik returns `weapon.name` for every kill, including ability/utility kills
 * — Phoenix's Curveball flash, Raze's Showstopper, Killjoy's TURRET, Sova's
 * Hunter's Fury, etc. Those would render as "Эксперт по Curveball" in the
 * weekly digest which reads weird; user prefers real-weapon records only.
 *
 * Vandal/Phantom are intentionally excluded (too dominant — would crowd out
 * the more interesting records). Knife/Fall are handled by their own detectors.
 */
const ALLOWED_WEAPONS = new Set([
  // Sidearms
  'Classic', 'Shorty', 'Frenzy', 'Ghost', 'Sheriff',
  // SMGs
  'Stinger', 'Spectre',
  // Shotguns
  'Bucky', 'Judge',
  // Rifles (Phantom + Vandal excluded as too dominant)
  'Bulldog', 'Guardian',
  // Snipers
  'Marshal', 'Outlaw', 'Operator',
  // Machine guns
  'Ares', 'Odin',
]);

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
    // Only canonical Valorant weapons count — abilities, utilities, knife,
    // fall damage, Vandal and Phantom are all filtered out.
    const byWeapon = new Map<string, number>();
    for (const k of kills) {
      if (k.attacker_puuid !== puuid) continue;
      if (!ALLOWED_WEAPONS.has(k.weapon)) continue;
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
