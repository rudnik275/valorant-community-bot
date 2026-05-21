import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordLegshotsMatchDetector } from './record-legshots-match.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;'); // allow orphan rows without users table
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    riot_puuid: 'puuid-test',
    match_id: 'match-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 15,
    deaths: 10,
    assists: 2,
    result: 'win',
    rounds_played: 20,
    rank_before: null,
    rank_after: null,
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: '[]',
    rounds_compact: null,
    per_round_afk_compact: null,
    score: null,
    headshots: 15,
    bodyshots: 40,
    legshots: 12,
    damage_dealt: null,
    damage_received: null,
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    survived_last_rounds: null,    died_first_rounds: null,    inserted_at: 1750000000000,
    ...overrides,
  };
}

function seedUser(sqlite: Database.Database, puuid: string, riotName: string, riotTag: string) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Math.floor(Math.random() * 100000), puuid, riotName, riotTag, Date.now());
}

describe('recordLegshotsMatchDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new record legshots > nothing → emits event with prev_value=null', async () => {
    const record = makeRecord({ legshots: 15 });
    const events = await recordLegshotsMatchDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_legshots_match');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(15);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new record legshots > existing → emits with prev_value and prev_name', async () => {
    seedUser(sqlite, 'puuid-first', 'LegPlayer', 'LEGS');

    // Insert initial record
    const firstRecord = makeRecord({ legshots: 10, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordLegshotsMatchDetector.detect(firstRecord, [], { db });

    // Beat it
    const newRecord = makeRecord({ legshots: 18, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordLegshotsMatchDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(18);
    expect(events[0]!.payload.prev_value).toBe(10);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    expect(events[0]!.payload.prev_name).toBe('LegPlayer');
    expect(events[0]!.payload.prev_tag).toBe('LEGS');
  });

  it('new record legshots < existing → no event', async () => {
    const firstRecord = makeRecord({ legshots: 20, match_id: 'match-first' });
    await recordLegshotsMatchDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ legshots: 12, match_id: 'match-lower' });
    const events = await recordLegshotsMatchDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('same player beats own record → emits with prev_puuid === current puuid', async () => {
    const puuid = 'puuid-same';
    seedUser(sqlite, puuid, 'SamePlayer', 'SAME');

    const firstRecord = makeRecord({ legshots: 10, match_id: 'match-first', riot_puuid: puuid });
    await recordLegshotsMatchDetector.detect(firstRecord, [], { db });

    const betterRecord = makeRecord({ legshots: 20, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordLegshotsMatchDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(20);
    expect(events[0]!.payload.prev_value).toBe(10);
    expect(events[0]!.payload.prev_puuid).toBe(puuid);
    expect(events[0]!.payload.prev_name).toBe('SamePlayer');
  });

  it('null legshots field → no event emitted', async () => {
    const record = makeRecord({ legshots: null });
    const events = await recordLegshotsMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no event emitted', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, legshots: 15 });
    const events = await recordLegshotsMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
