import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { upsertWeeklyLeader, getAllTimeMaxWeeklyValue } from './record-tracker.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('upsertWeeklyLeader', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('empty table + insert → beatenForWeek=true', async () => {
    const result = await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 3,
    });

    expect(result.beatenForWeek).toBe(true);

    const rows = sqlite.prepare('SELECT * FROM weekly_records WHERE record_type = ?').all('mvp_count_week');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['value']).toBe(3);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-1');
    expect((rows[0] as Record<string, unknown>)['week_iso']).toBe('2026-W19');
  });

  it('existing record, same value → beatenForWeek=false (ties do NOT beat)', async () => {
    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 3,
    });

    const result = await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-2',
      value: 3,
    });

    expect(result.beatenForWeek).toBe(false);

    // DB should still hold original leader
    const rows = sqlite.prepare('SELECT * FROM weekly_records WHERE record_type = ?').all('mvp_count_week');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-1');
  });

  it('existing record, lower value → beatenForWeek=false', async () => {
    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 5,
    });

    const result = await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-2',
      value: 3,
    });

    expect(result.beatenForWeek).toBe(false);
  });

  it('existing record, higher value → beatenForWeek=true, updates leader', async () => {
    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 3,
    });

    const result = await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-2',
      value: 5,
    });

    expect(result.beatenForWeek).toBe(true);

    const rows = sqlite.prepare('SELECT * FROM weekly_records WHERE record_type = ?').all('mvp_count_week');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-2');
    expect((rows[0] as Record<string, unknown>)['value']).toBe(5);
  });

  it('different weeks use separate PK slots', async () => {
    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 3,
    });

    const result = await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W20',
      riotPuuid: 'puuid-2',
      value: 2,
    });

    expect(result.beatenForWeek).toBe(true);

    const rows = sqlite.prepare('SELECT * FROM weekly_records WHERE record_type = ?').all('mvp_count_week');
    expect(rows).toHaveLength(2);
  });

  it('different record_types use separate PK slots', async () => {
    await upsertWeeklyLeader(db, {
      recordType: 'mvp_count_week',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-1',
      value: 3,
    });

    const result = await upsertWeeklyLeader(db, {
      recordType: 'other_record',
      weekIso: '2026-W19',
      riotPuuid: 'puuid-2',
      value: 10,
    });

    expect(result.beatenForWeek).toBe(true);

    const rows = sqlite.prepare('SELECT * FROM weekly_records').all();
    expect(rows).toHaveLength(2);
  });
});

describe('getAllTimeMaxWeeklyValue', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns null when no records exist', async () => {
    const result = await getAllTimeMaxWeeklyValue(db, 'mvp_count_week');
    expect(result).toBeNull();
  });

  it('returns the single record when one exists', async () => {
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2026-W19', 'puuid-1', 4);

    const result = await getAllTimeMaxWeeklyValue(db, 'mvp_count_week');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(4);
    expect(result!.weekIso).toBe('2026-W19');
    expect(result!.puuid).toBe('puuid-1');
  });

  it('returns the highest value across multiple weeks', async () => {
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2026-W18', 'puuid-1', 3);
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2026-W19', 'puuid-2', 7);
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2026-W20', 'puuid-3', 5);

    const result = await getAllTimeMaxWeeklyValue(db, 'mvp_count_week');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(7);
    expect(result!.weekIso).toBe('2026-W19');
    expect(result!.puuid).toBe('puuid-2');
  });

  it('ignores other record_types', async () => {
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('other_record', '2026-W19', 'puuid-1', 99);
    sqlite.prepare(
      'INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES (?, ?, ?, ?)',
    ).run('mvp_count_week', '2026-W19', 'puuid-2', 4);

    const result = await getAllTimeMaxWeeklyValue(db, 'mvp_count_week');
    expect(result!.value).toBe(4);
    expect(result!.puuid).toBe('puuid-2');
  });
});
