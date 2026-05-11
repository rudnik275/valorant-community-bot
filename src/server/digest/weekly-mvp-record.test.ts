import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { computeAndEmitWeeklyMvpRecord } from './weekly-mvp-record.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

// ─── Seed helpers ────────────────────────────────────────────────────────────

function seedUser(sqlite: Database.Database, id: number, puuid: string, name = `Player${id}`, tag = 'TAG') {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, puuid, name, tag, Date.now());
}

interface MatchSeedOpts {
  puuid: string;
  matchId: string;
  startedAt: number;
  isMvp?: 0 | 1;
}

function seedMatch(sqlite: Database.Database, opts: MatchSeedOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO match_records
     (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact, is_match_mvp)
     VALUES (?, ?, ?, 'Ascent', 'Jett', 10, 5, 2, 'win', 20, '[]', ?)`,
  ).run(opts.puuid, opts.matchId, opts.startedAt, opts.isMvp ?? 0);
}

function getDetectedEvents(sqlite: Database.Database) {
  return sqlite.prepare('SELECT * FROM detected_events WHERE event_type = ?').all('record_mvp_count_week') as Array<Record<string, unknown>>;
}

function getWeeklyRecords(sqlite: Database.Database) {
  return sqlite.prepare('SELECT * FROM weekly_records WHERE record_type = ?').all('mvp_count_week') as Array<Record<string, unknown>>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WEEK_END = 1_746_000_000_000;
const WEEK_START = WEEK_END - 7 * 86400000;
const IN_WINDOW = WEEK_START + 86400000;
const WEEK_ISO = '2025-W18'; // approximate week for WEEK_END timestamp

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeAndEmitWeeklyMvpRecord', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('does nothing when no matches in window', async () => {
    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);
    expect(getDetectedEvents(sqlite)).toHaveLength(0);
    expect(getWeeklyRecords(sqlite)).toHaveLength(0);
  });

  it('does nothing when all matches have is_match_mvp=0', async () => {
    seedUser(sqlite, 1, 'p1');
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 0 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 0 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);
    expect(getDetectedEvents(sqlite)).toHaveLength(0);
  });

  it('emits event when first-ever weekly MVP record is set', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    const events = getDetectedEvents(sqlite);
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event['event_type']).toBe('record_mvp_count_week');
    expect(event['riot_puuid']).toBe('p1');
    expect(event['status']).toBe('digest-only');
    expect(event['match_id']).toBe(`weekly:mvp:${WEEK_ISO}`);

    const payload = JSON.parse(event['payload_json'] as string);
    expect(payload.value).toBe(2);
    expect(payload.prev_value).toBe(0);
    expect(payload.prev_puuid).toBeNull();
    expect(payload.week_iso).toBe(WEEK_ISO);
  });

  it('upserts weekly_records when leader has mvp > 0', async () => {
    seedUser(sqlite, 1, 'p1');
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    const records = getWeeklyRecords(sqlite);
    expect(records).toHaveLength(1);
    expect(records[0]!['riot_puuid']).toBe('p1');
    expect(records[0]!['value']).toBe(1);
    expect(records[0]!['week_iso']).toBe(WEEK_ISO);
  });

  it('does NOT emit event when current week ties all-time best', async () => {
    // Seed a previous week with value=3
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2025-W17', 'p2', 3);

    seedUser(sqlite, 1, 'p1');
    // p1 has 3 MVPs this week — same as all-time max
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm3', startedAt: IN_WINDOW + 2000, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    // No event emitted (tie does not beat all-time record)
    expect(getDetectedEvents(sqlite)).toHaveLength(0);
  });

  it('emits event when current week strictly beats all-time best', async () => {
    seedUser(sqlite, 1, 'p2', 'Beta', 'BBB');
    // Seed a previous week with value=3 for p2
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2025-W17', 'p2', 3);

    seedUser(sqlite, 2, 'p1', 'Alpha', 'AAA');
    // p1 has 4 MVPs this week — beats all-time max of 3
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm3', startedAt: IN_WINDOW + 2000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm4', startedAt: IN_WINDOW + 3000, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    const events = getDetectedEvents(sqlite);
    expect(events).toHaveLength(1);

    const payload = JSON.parse(events[0]!['payload_json'] as string);
    expect(payload.value).toBe(4);
    expect(payload.prev_value).toBe(3);
    expect(payload.prev_puuid).toBe('p2');
    expect(payload.prev_name).toBe('Beta');
    expect(payload.prev_tag).toBe('BBB');
  });

  it('picks the player with most MVPs as leader when multiple players have MVPs', async () => {
    seedUser(sqlite, 1, 'p1');
    seedUser(sqlite, 2, 'p2');

    // p1: 2 MVPs, p2: 3 MVPs
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p2', matchId: 'm3', startedAt: IN_WINDOW + 2000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p2', matchId: 'm4', startedAt: IN_WINDOW + 3000, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p2', matchId: 'm5', startedAt: IN_WINDOW + 4000, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    const records = getWeeklyRecords(sqlite);
    expect(records[0]!['riot_puuid']).toBe('p2');
    expect(records[0]!['value']).toBe(3);

    const events = getDetectedEvents(sqlite);
    expect(events).toHaveLength(1);
    expect(events[0]!['riot_puuid']).toBe('p2');
    const payload = JSON.parse(events[0]!['payload_json'] as string);
    expect(payload.value).toBe(3);
  });

  it('is idempotent — calling twice does not duplicate events', async () => {
    seedUser(sqlite, 1, 'p1');
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);
    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    expect(getDetectedEvents(sqlite)).toHaveLength(1);
  });

  it('ignores matches outside window', async () => {
    seedUser(sqlite, 1, 'p1');
    const OUT_OF_WINDOW = WEEK_START - 86400000;
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: OUT_OF_WINDOW, isMvp: 1 });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: OUT_OF_WINDOW, isMvp: 1 });

    await computeAndEmitWeeklyMvpRecord(db, WEEK_START, WEEK_END, WEEK_ISO);

    expect(getDetectedEvents(sqlite)).toHaveLength(0);
    expect(getWeeklyRecords(sqlite)).toHaveLength(0);
  });
});
