import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordKillsMatchDetector } from './record-kills-match.ts';
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
    kills: 25,
    deaths: 10,
    assists: 2,
    result: 'win',
    rounds_played: 20,
    rank_before: null,
    rank_after: 'Diamond 1',
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: '[]',
    rounds_compact: null,
    per_round_afk_compact: null,
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
    survived_last_rounds: null,    inserted_at: 1750000000000,
    ...overrides,
  };
}

describe('recordKillsMatchDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new record kills > nothing → emits event with prev_value=null', async () => {
    const record = makeRecord({ kills: 30 });
    const events = await recordKillsMatchDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_kills_match');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(30);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new record kills > existing → emits with prev_value', async () => {
    // Insert initial record
    const firstRecord = makeRecord({ kills: 20, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordKillsMatchDetector.detect(firstRecord, [], { db });

    // Beat it
    const newRecord = makeRecord({ kills: 35, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordKillsMatchDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(35);
    expect(events[0]!.payload.prev_value).toBe(20);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
  });

  it('new record kills < existing → no event', async () => {
    // Insert initial record with high kills
    const firstRecord = makeRecord({ kills: 40, match_id: 'match-first' });
    await recordKillsMatchDetector.detect(firstRecord, [], { db });

    // Try to beat with lower value
    const lowerRecord = makeRecord({ kills: 25, match_id: 'match-lower' });
    const events = await recordKillsMatchDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('same player beats own record → emits with prev_puuid === current puuid', async () => {
    const puuid = 'puuid-same';

    // Player sets initial record
    const firstRecord = makeRecord({ kills: 20, match_id: 'match-first', riot_puuid: puuid });
    await recordKillsMatchDetector.detect(firstRecord, [], { db });

    // Same player beats own record
    const betterRecord = makeRecord({ kills: 30, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordKillsMatchDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(30);
    expect(events[0]!.payload.prev_value).toBe(20);
    expect(events[0]!.payload.prev_puuid).toBe(puuid); // same player
  });

  it('null riot_puuid → no event emitted', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, kills: 30 });
    const events = await recordKillsMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
