/**
 * queries.test.ts — Typed query module, exercised against REAL in-memory
 * SQLite + migrations (project rule: never mock the DB — mocked-DB tests
 * passed while migrations broke in prod).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { matchRecords } from './schema/match_records.ts';
import { matchRosters } from './schema/match_rosters.ts';
import { detectedEvents } from './schema/detected_events.ts';
import { users } from './schema/users.ts';
import {
  PREV_RECORDS_LIMIT,
  getPrevRecords,
  hasEventSince,
  hasMatchEvent,
  getCommunityRoster,
  getExistingMatchIdsForPuuid,
  getRegionForPuuid,
  getUserNameTag,
  getUsersByPuuids,
  type SqliteDb,
} from './queries.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as SqliteDb, sqlite };
}

function recordRow(over: Partial<typeof matchRecords.$inferInsert> = {}): typeof matchRecords.$inferInsert {
  return {
    riot_puuid: 'p1',
    match_id: 'm1',
    started_at: 1_000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 10,
    deaths: 5,
    assists: 3,
    result: 'win',
    rounds_played: 20,
    rank_before: null,
    rank_after: null,
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: '[]',
    rounds_compact: '[]',
    score: null,
    headshots: null,
    bodyshots: null,
    legshots: null,
    damage_dealt: null,
    damage_received: null,
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    survived_last_rounds: null,    died_first_rounds: null,    ...over,
  };
}

describe('db/queries', () => {
  let db: SqliteDb;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });
  afterEach(() => sqlite.close());

  describe('getPrevRecords', () => {
    it('returns records strictly before started_at, DESC, capped at limit', async () => {
      const rows = [];
      for (let i = 1; i <= 35; i++) {
        rows.push(recordRow({ match_id: `m${i}`, started_at: i * 100 }));
      }
      await db.insert(matchRecords).values(rows);

      // beforeStartedAt = 10_000 → all 35 qualify; limit caps to 30, DESC.
      const prev = await getPrevRecords(db, 'p1', 10_000);
      expect(prev).toHaveLength(PREV_RECORDS_LIMIT);
      expect(prev[0]!.started_at).toBe(3500); // m35, most recent first
      expect(prev[1]!.started_at).toBe(3400);
    });

    it('excludes the boundary (strictly less-than) and other puuids', async () => {
      await db.insert(matchRecords).values([
        recordRow({ match_id: 'a', started_at: 500 }),
        recordRow({ match_id: 'b', started_at: 1000 }), // == boundary, excluded
        recordRow({ match_id: 'c', started_at: 1500 }), // > boundary, excluded
        recordRow({ riot_puuid: 'other', match_id: 'd', started_at: 200 }),
      ]);
      const prev = await getPrevRecords(db, 'p1', 1000);
      expect(prev.map((r) => r.match_id)).toEqual(['a']);
    });

    it('honours a custom limit', async () => {
      await db.insert(matchRecords).values([
        recordRow({ match_id: 'a', started_at: 100 }),
        recordRow({ match_id: 'b', started_at: 200 }),
        recordRow({ match_id: 'c', started_at: 300 }),
      ]);
      const prev = await getPrevRecords(db, 'p1', 9999, 2);
      expect(prev).toHaveLength(2);
      expect(prev[0]!.match_id).toBe('c');
    });
  });

  describe('hasEventSince', () => {
    it('true only for matching (event_type, puuid) at/after sinceMs', async () => {
      await db.insert(detectedEvents).values([
        { event_type: 'winstreak_10plus', riot_puuid: 'p1', match_id: 'm1', payload_json: '{}', detected_at: 5_000 },
        { event_type: 'winstreak_10plus', riot_puuid: 'p2', match_id: 'm2', payload_json: '{}', detected_at: 9_000 },
        { event_type: 'ace', riot_puuid: 'p1', match_id: 'm3', payload_json: '{}', detected_at: 9_000 },
      ]);
      expect(await hasEventSince(db, 'winstreak_10plus', 'p1', 4_000)).toBe(true);
      expect(await hasEventSince(db, 'winstreak_10plus', 'p1', 6_000)).toBe(false); // before sinceMs
      expect(await hasEventSince(db, 'winstreak_10plus', 'p3', 0)).toBe(false); // other puuid
      expect(await hasEventSince(db, 'ace', 'p1', 0)).toBe(true);
    });
  });

  describe('hasMatchEvent', () => {
    it('true when ANY event of type exists for the match (regardless of puuid)', async () => {
      await db.insert(detectedEvents).values([
        { event_type: 'match_comeback', riot_puuid: 'p9', match_id: 'mX', payload_json: '{}', detected_at: 1 },
      ]);
      expect(await hasMatchEvent(db, 'match_comeback', 'mX')).toBe(true);
      expect(await hasMatchEvent(db, 'match_comeback', 'mY')).toBe(false);
      expect(await hasMatchEvent(db, 'community_clash', 'mX')).toBe(false);
    });
  });

  describe('getCommunityRoster', () => {
    beforeEach(async () => {
      await db.insert(users).values([
        { telegram_id: 1, riot_puuid: 'p1', riot_name: 'Alice', riot_tag: 'AAA' },
        { telegram_id: 2, riot_puuid: 'p2', riot_name: 'Bob', riot_tag: 'BBB' },
      ]);
      await db.insert(matchRosters).values([
        { match_id: 'm1', riot_puuid: 'p1', team: 'Blue' },
        { match_id: 'm1', riot_puuid: 'p2', team: 'Red' },
        { match_id: 'm1', riot_puuid: 'stranger', team: 'Blue' }, // not a user → excluded
      ]);
    });

    it('inner-joins users (only known community members)', async () => {
      const rows = await getCommunityRoster(db, 'm1');
      expect(rows.map((r) => r.riot_puuid).sort()).toEqual(['p1', 'p2']);
      const alice = rows.find((r) => r.riot_puuid === 'p1')!;
      expect(alice).toMatchObject({ team: 'Blue', riot_name: 'Alice', riot_tag: 'AAA' });
    });

    it('filters by team when provided', async () => {
      const rows = await getCommunityRoster(db, 'm1', 'Blue');
      expect(rows.map((r) => r.riot_puuid)).toEqual(['p1']);
    });
  });

  describe('getExistingMatchIdsForPuuid', () => {
    it('is scoped per-puuid (a friend in the same lobby does NOT mask)', async () => {
      await db.insert(matchRecords).values([
        recordRow({ riot_puuid: 'p1', match_id: 'shared' }),
        recordRow({ riot_puuid: 'friend', match_id: 'shared' }),
        recordRow({ riot_puuid: 'p1', match_id: 'solo' }),
      ]);
      const got = await getExistingMatchIdsForPuuid(db, 'p1', ['shared', 'solo', 'never']);
      expect([...got].sort()).toEqual(['shared', 'solo']);

      // friend's own perspective: 'solo' is NOT theirs.
      const friendGot = await getExistingMatchIdsForPuuid(db, 'friend', ['shared', 'solo']);
      expect([...friendGot]).toEqual(['shared']);
    });

    it('empty input → empty set, no query', async () => {
      expect(await getExistingMatchIdsForPuuid(db, 'p1', [])).toEqual(new Set());
    });
  });

  describe('getRegionForPuuid / getUserNameTag / getUsersByPuuids', () => {
    beforeEach(async () => {
      await db.insert(users).values([
        { telegram_id: 1, riot_puuid: 'p1', riot_name: 'Alice', riot_tag: 'AAA', riot_region: 'eu' },
        { telegram_id: 2, riot_puuid: 'p2', riot_name: null, riot_tag: null, riot_region: null },
      ]);
    });

    it('getRegionForPuuid returns region or null (unknown / null column)', async () => {
      expect(await getRegionForPuuid(db, 'p1')).toBe('eu');
      expect(await getRegionForPuuid(db, 'p2')).toBeNull();
      expect(await getRegionForPuuid(db, 'ghost')).toBeNull();
    });

    it('getUserNameTag normalises nulls / unknown user to empty strings', async () => {
      expect(await getUserNameTag(db, 'p1')).toEqual({ name: 'Alice', tag: 'AAA' });
      expect(await getUserNameTag(db, 'p2')).toEqual({ name: '', tag: '' });
      expect(await getUserNameTag(db, 'ghost')).toEqual({ name: '', tag: '' });
    });

    it('getUsersByPuuids returns matching users; [] for empty input', async () => {
      expect(await getUsersByPuuids(db, [])).toEqual([]);
      const rows = await getUsersByPuuids(db, ['p1', 'p2', 'ghost']);
      expect(rows.map((r) => r.riot_puuid).sort()).toEqual(['p1', 'p2']);
    });
  });
});
