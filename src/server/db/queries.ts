/**
 * queries.ts — Typed query module for match-record / detected-event reads.
 *
 * Before this module, `DetectorDeps.db` was typed `any` (to dodge a circular
 * import: `types.ts` ← schema ← detectors ← `types.ts`) and every detector,
 * the orchestrator, the scanner and both digests reached across the DB seam
 * with copy-pasted Drizzle. This module owns the schema import and exposes
 * named, documented queries; detectors import THIS module, so `DetectorDeps.db`
 * can become a typed Drizzle handle and the circular import is gone.
 *
 * Index / ordering / dedup assumptions are documented HERE, in one place,
 * instead of being re-discovered at each call site.
 *
 * Project rule: this module is tested against real in-memory SQLite +
 * migrations — never a mocked DB (mocked-DB tests passed while migrations
 * broke in prod).
 */

import { eq, and, lt, gte, desc, inArray } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { matchRecords } from './schema/match_records.ts';
import { matchRosters } from './schema/match_rosters.ts';
import { detectedEvents } from './schema/detected_events.ts';
import { users } from './schema/users.ts';
import type { MatchRecord } from '../publisher/types.ts';

/**
 * Driver-agnostic Drizzle SQLite handle.
 *
 * Prod uses `drizzle-orm/bun-sqlite`; tests use `drizzle-orm/better-sqlite3`.
 * Both are synchronous drivers, but the broad `'sync' | 'async'` result-kind
 * and `any` run-result keep this assignable from either `drizzle()` return
 * type without leaking driver specifics into the detector seam.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqliteDb = BaseSQLiteDatabase<'sync' | 'async', any, any>;

/**
 * Default number of previous match records pulled for streak / comeback /
 * promo logic. Historically hard-coded as `.limit(30)` in `detect.ts` with no
 * rationale — documented here: 30 covers a long winstreak (≥10) plus headroom
 * for promo/comeback look-back, while bounding the per-tick query.
 */
export const PREV_RECORDS_LIMIT = 30;

export interface CommunityRosterRow {
  riot_puuid: string;
  team: string;
  riot_name: string | null;
  riot_tag: string | null;
  agent: string | null;
}

/**
 * Previous match records for a puuid, strictly BEFORE `beforeStartedAt`,
 * ordered DESC by `started_at`, capped at `limit` (default
 * {@link PREV_RECORDS_LIMIT}).
 *
 * Backed by index `idx_match_records_puuid_started_at`
 * (`riot_puuid`, `started_at`). The DESC ordering + limit is the contract the
 * winstreak / comeback / promo detectors rely on (they re-sort defensively but
 * assume "most-recent-first, bounded").
 */
export async function getPrevRecords(
  db: SqliteDb,
  puuid: string,
  beforeStartedAt: number,
  limit: number = PREV_RECORDS_LIMIT,
): Promise<MatchRecord[]> {
  return (await db
    .select()
    .from(matchRecords)
    .where(
      and(
        eq(matchRecords.riot_puuid, puuid),
        lt(matchRecords.started_at, beforeStartedAt),
      ),
    )
    .orderBy(desc(matchRecords.started_at))
    .limit(limit)) as MatchRecord[];
}

/**
 * True iff a detected event of `eventType` for `puuid` already exists with
 * `detected_at >= sinceMs`. Used by the winstreak detector for per-puuid
 * weekly dedup (`sinceMs` = start of the ISO week). Scope: a single
 * (event_type, riot_puuid) pair within the time window — NOT global.
 */
export async function hasEventSince(
  db: SqliteDb,
  eventType: string,
  puuid: string,
  sinceMs: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: detectedEvents.id })
    .from(detectedEvents)
    .where(
      and(
        eq(detectedEvents.event_type, eventType),
        eq(detectedEvents.riot_puuid, puuid),
        gte(detectedEvents.detected_at, sinceMs),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * True iff ANY detected event of `eventType` already exists for `matchId`
 * (regardless of which community player triggered the scan). Used by
 * match-comeback / community-clash as a per-match idempotency guard so the
 * same match scanned for N community members emits ONE event, not N.
 */
export async function hasMatchEvent(
  db: SqliteDb,
  eventType: string,
  matchId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: detectedEvents.id })
    .from(detectedEvents)
    .where(
      and(
        eq(detectedEvents.event_type, eventType),
        eq(detectedEvents.match_id, matchId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * `match_rosters ⋈ users` for a match — only roster rows whose puuid is a
 * known community member (INNER join on `users.riot_puuid`). Optionally
 * filtered to a single `team`. Previously duplicated verbatim in
 * match-comeback (team-filtered) and community-clash (all teams).
 */
export async function getCommunityRoster(
  db: SqliteDb,
  matchId: string,
  team?: string,
): Promise<CommunityRosterRow[]> {
  const conditions = [eq(matchRosters.match_id, matchId)];
  if (team !== undefined) conditions.push(eq(matchRosters.team, team));
  return (await db
    .select({
      riot_puuid: matchRosters.riot_puuid,
      team: matchRosters.team,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
      agent: matchRosters.agent,
    })
    .from(matchRosters)
    .innerJoin(users, eq(users.riot_puuid, matchRosters.riot_puuid))
    .where(and(...conditions))) as CommunityRosterRow[];
}

/**
 * Subset of `matchIds` that ALREADY have a `match_records` row for THIS
 * `puuid`. The PK is (riot_puuid, match_id), so the same match has one row
 * per community player — the existence check MUST be scoped by puuid,
 * otherwise a row inserted earlier for a friend in the same lobby would mask
 * this user's missing record and the scanner would silently skip them.
 */
export async function getExistingMatchIdsForPuuid(
  db: SqliteDb,
  puuid: string,
  matchIds: string[],
): Promise<Set<string>> {
  if (matchIds.length === 0) return new Set();
  const rows = (await db
    .select({ match_id: matchRecords.match_id })
    .from(matchRecords)
    .where(
      and(
        eq(matchRecords.riot_puuid, puuid),
        inArray(matchRecords.match_id, matchIds),
      ),
    )) as Array<{ match_id: string }>;
  return new Set(rows.map((r) => r.match_id));
}

/**
 * `riot_region` for a puuid from the `users` table, or null when the user is
 * unknown / has no region. Used by the orchestrator for opponent-peak
 * augmentation.
 */
export async function getRegionForPuuid(
  db: SqliteDb,
  puuid: string,
): Promise<string | null> {
  const rows = (await db
    .select({ riot_region: users.riot_region })
    .from(users)
    .where(eq(users.riot_puuid, puuid))
    .limit(1)) as Array<{ riot_region: string | null }>;
  return rows[0]?.riot_region ?? null;
}

/**
 * `(riot_name, riot_tag)` for a puuid, normalised to non-null strings (`''`
 * when the column is null OR the user is unknown). This is the previous
 * record-holder lookup duplicated verbatim across every `record_*_match`
 * detector (and weekly-mvp / kills-per-weapon).
 */
export async function getUserNameTag(
  db: SqliteDb,
  puuid: string,
): Promise<{ name: string; tag: string }> {
  const rows = (await db
    .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
    .from(users)
    .where(eq(users.riot_puuid, puuid))
    .limit(1)) as Array<{ riot_name: string | null; riot_tag: string | null }>;
  const row = rows[0];
  return { name: row?.riot_name ?? '', tag: row?.riot_tag ?? '' };
}

/**
 * `users` rows (puuid, name, tag) for the given puuids — community-member
 * filter for the teamkill detector (only victims who are known users count).
 */
export async function getUsersByPuuids(
  db: SqliteDb,
  puuids: string[],
): Promise<Array<{ riot_puuid: string; riot_name: string | null; riot_tag: string | null }>> {
  if (puuids.length === 0) return [];
  return (await db
    .select({
      riot_puuid: users.riot_puuid,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
    })
    .from(users)
    .where(inArray(users.riot_puuid, puuids))) as Array<{
      riot_puuid: string;
      riot_name: string | null;
      riot_tag: string | null;
    }>;
}
