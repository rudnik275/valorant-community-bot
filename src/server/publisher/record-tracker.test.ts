import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { upsertRecord } from './record-tracker.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;'); // allow orphan rows without users table
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('upsertRecord', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('empty table + insert → beaten=true, prev=null', async () => {
    const result = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 25,
      riotPuuid: 'puuid-1',
      matchId: 'match-1',
    });

    expect(result.beaten).toBe(true);
    expect(result.prev).toBeNull();

    const rows = sqlite.prepare('SELECT * FROM all_time_records WHERE record_type = ?').all('kills_match');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['value']).toBe(25);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-1');
  });

  it('existing record, new lower value → beaten=false, prev=existing', async () => {
    // Insert initial record
    await upsertRecord(db, {
      recordType: 'kills_match',
      value: 30,
      riotPuuid: 'puuid-1',
      matchId: 'match-1',
    });

    // Try to beat with lower value
    const result = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 20,
      riotPuuid: 'puuid-2',
      matchId: 'match-2',
    });

    expect(result.beaten).toBe(false);
    expect(result.prev).toEqual({ value: 30, puuid: 'puuid-1' });

    // DB should still hold original record
    const rows = sqlite.prepare('SELECT * FROM all_time_records WHERE record_type = ?').all('kills_match');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-1');
  });

  it('existing record, same value → beaten=false (ties do NOT beat)', async () => {
    await upsertRecord(db, {
      recordType: 'kills_match',
      value: 30,
      riotPuuid: 'puuid-1',
      matchId: 'match-1',
    });

    const result = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 30,
      riotPuuid: 'puuid-2',
      matchId: 'match-2',
    });

    expect(result.beaten).toBe(false);
    expect(result.prev).toEqual({ value: 30, puuid: 'puuid-1' });
  });

  it('existing record, new higher value → beaten=true, prev=existing', async () => {
    // Insert initial record
    await upsertRecord(db, {
      recordType: 'kills_match',
      value: 20,
      riotPuuid: 'puuid-1',
      matchId: 'match-1',
    });

    // Beat with higher value
    const result = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 35,
      riotPuuid: 'puuid-2',
      matchId: 'match-2',
    });

    expect(result.beaten).toBe(true);
    expect(result.prev).toEqual({ value: 20, puuid: 'puuid-1' });

    // DB should now have new record with prev_value set
    const rows = sqlite.prepare('SELECT * FROM all_time_records WHERE record_type = ?').all('kills_match');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['riot_puuid']).toBe('puuid-2');
    expect((rows[0] as Record<string, unknown>)['value']).toBe(35);
    expect((rows[0] as Record<string, unknown>)['prev_value']).toBe(20);
    expect((rows[0] as Record<string, unknown>)['prev_puuid']).toBe('puuid-1');
  });

  it('two upserts back-to-back: second one prev should reflect first value', async () => {
    // First upsert
    const r1 = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 10,
      riotPuuid: 'puuid-a',
      matchId: 'match-a',
    });
    expect(r1.beaten).toBe(true);
    expect(r1.prev).toBeNull();

    // Second upsert beating first
    const r2 = await upsertRecord(db, {
      recordType: 'kills_match',
      value: 20,
      riotPuuid: 'puuid-b',
      matchId: 'match-b',
    });
    expect(r2.beaten).toBe(true);
    expect(r2.prev).toEqual({ value: 10, puuid: 'puuid-a' });

    // DB record should reflect second upsert's values with prev pointing to first
    const rows = sqlite.prepare('SELECT * FROM all_time_records WHERE record_type = ?').all('kills_match');
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>)['value']).toBe(20);
    expect((rows[0] as Record<string, unknown>)['prev_value']).toBe(10);
    expect((rows[0] as Record<string, unknown>)['prev_puuid']).toBe('puuid-a');
  });

  it('weapon parameter uses separate PK slot', async () => {
    await upsertRecord(db, {
      recordType: 'kills_match',
      value: 25,
      riotPuuid: 'puuid-1',
      matchId: 'match-1',
    });

    // Same record_type but different weapon → separate row
    const result = await upsertRecord(db, {
      recordType: 'kills_match',
      weapon: 'Vandal',
      value: 10,
      riotPuuid: 'puuid-2',
      matchId: 'match-2',
    });

    expect(result.beaten).toBe(true);
    expect(result.prev).toBeNull();

    const rows = sqlite.prepare('SELECT * FROM all_time_records').all();
    expect(rows).toHaveLength(2);
  });
});
