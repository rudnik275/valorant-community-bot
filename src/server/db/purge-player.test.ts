/**
 * purge-player.test.ts — Unit tests for purgePlayer.
 *
 * Real SQLite (:memory:), PRAGMA foreign_keys=ON.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { purgePlayer } from './purge-player.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('purgePlayer', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  it('deletes target player from all five tables and leaves second player untouched', async () => {
    // Seed user A (the one to purge)
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-a', 'PlayerA', 'TAG1')`);
    // Seed user B (must remain)
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (2, 'puuid-b', 'PlayerB', 'TAG2')`);

    // match_records for user A
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-a', 'match-a1', 1000, 'Ascent', 'Jett', 20, 5, 3, 'win', 25, '[]')`);
    // match_records for user B
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-b', 'match-b1', 1001, 'Bind', 'Sage', 10, 8, 4, 'loss', 24, '[]')`);

    // all_time_records for user A
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('kills_match', '', 'puuid-a', 20, 'match-a1', 1000)`);
    // all_time_records for user B
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('deaths_match', '', 'puuid-b', 8, 'match-b1', 1001)`);

    // weekly_records for user A
    sqlite.exec(`INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES ('mvp_count_week', '2024-W01', 'puuid-a', 3)`);
    // weekly_records for user B
    sqlite.exec(`INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES ('mvp_count_week', '2024-W02', 'puuid-b', 2)`);

    // detected_events for user A
    sqlite.exec(`INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('ace', 'puuid-a', 'match-a1', '{}', 'pending')`);
    // detected_events for user B
    sqlite.exec(`INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('clutch', 'puuid-b', 'match-b1', '{}', 'pending')`);

    const counts = await purgePlayer(db, { telegramId: 1, riotPuuid: 'puuid-a' });

    // User A gone from all tables
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=1`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM match_records WHERE riot_puuid='puuid-a'`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM all_time_records WHERE riot_puuid='puuid-a'`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM weekly_records WHERE riot_puuid='puuid-a'`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM detected_events WHERE riot_puuid='puuid-a'`).all()).toHaveLength(0);

    // User B fully intact
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=2`).all()).toHaveLength(1);
    expect(sqlite.prepare(`SELECT * FROM match_records WHERE riot_puuid='puuid-b'`).all()).toHaveLength(1);
    expect(sqlite.prepare(`SELECT * FROM all_time_records WHERE riot_puuid='puuid-b'`).all()).toHaveLength(1);
    expect(sqlite.prepare(`SELECT * FROM weekly_records WHERE riot_puuid='puuid-b'`).all()).toHaveLength(1);
    expect(sqlite.prepare(`SELECT * FROM detected_events WHERE riot_puuid='puuid-b'`).all()).toHaveLength(1);

    // Correct counts returned
    expect(counts.detectedEvents).toBe(1);
    expect(counts.allTimeRecords).toBe(1);
    expect(counts.weeklyRecords).toBe(1);
    expect(counts.matchRecords).toBe(1);
    expect(counts.users).toBe(1);
  });

  it('does NOT throw with foreign_keys=ON (proves FK ordering is correct)', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (10, 'puuid-x', 'PlayerX', 'XX')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-x', 'match-x', 2000, 'Haven', 'Omen', 15, 6, 2, 'win', 26, '[]')`);
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('kills_match', '', 'puuid-x', 15, 'match-x', 2000)`);
    sqlite.exec(`INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('ace', 'puuid-x', 'match-x', '{}', 'pending')`);

    // Should not throw
    await expect(purgePlayer(db, { telegramId: 10, riotPuuid: 'puuid-x' })).resolves.toBeDefined();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=10`).all()).toHaveLength(0);
  });

  it('null riot_puuid → only users row deleted, counts are zero for everything else', async () => {
    // Seed a user with no puuid (never linked)
    sqlite.exec(`INSERT INTO users (telegram_id) VALUES (20)`);

    const counts = await purgePlayer(db, { telegramId: 20, riotPuuid: null });

    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=20`).all()).toHaveLength(0);
    expect(counts.detectedEvents).toBe(0);
    expect(counts.allTimeRecords).toBe(0);
    expect(counts.weeklyRecords).toBe(0);
    expect(counts.matchRecords).toBe(0);
    expect(counts.users).toBe(1);
  });

  it('multiple rows per table for same puuid → all deleted, counts correct', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid) VALUES (30, 'puuid-multi')`);
    // Two match records
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-multi', 'match-m1', 3000, 'Split', 'Reyna', 12, 4, 1, 'win', 25, '[]')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-multi', 'match-m2', 3001, 'Icebox', 'Breach', 8, 7, 5, 'loss', 25, '[]')`);
    // Two detected_events
    sqlite.exec(`INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('ace', 'puuid-multi', 'match-m1', '{}', 'pending')`);
    sqlite.exec(`INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, status) VALUES ('clutch', 'puuid-multi', 'match-m2', '{}', 'pending')`);

    const counts = await purgePlayer(db, { telegramId: 30, riotPuuid: 'puuid-multi' });

    expect(counts.matchRecords).toBe(2);
    expect(counts.detectedEvents).toBe(2);
    expect(sqlite.prepare(`SELECT * FROM match_records WHERE riot_puuid='puuid-multi'`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM detected_events WHERE riot_puuid='puuid-multi'`).all()).toHaveLength(0);
  });
});
