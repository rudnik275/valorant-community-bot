import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordDamageDealtMatchDetector } from './record-damage-dealt-match.ts';
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
    damage_dealt: 6840,
    damage_received: null,
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    inserted_at: 1750000000000,
    ...overrides,
  };
}

describe('recordDamageDealtMatchDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new value > nothing → emits event with prev_value=null', async () => {
    const record = makeRecord({ damage_dealt: 6840 });
    const events = await recordDamageDealtMatchDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_damage_dealt_match');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(6840);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new value > existing → emits with prev_value and prev_name set', async () => {
    // Insert initial record
    const firstRecord = makeRecord({ damage_dealt: 6000, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordDamageDealtMatchDetector.detect(firstRecord, [], { db });

    // Beat it
    const newRecord = makeRecord({ damage_dealt: 7200, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordDamageDealtMatchDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(7200);
    expect(events[0]!.payload.prev_value).toBe(6000);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    // prev_name/prev_tag may be empty string since no user seeded
    expect(events[0]!.payload).toHaveProperty('prev_name');
    expect(events[0]!.payload).toHaveProperty('prev_tag');
  });

  it('new value <= existing → no event', async () => {
    const firstRecord = makeRecord({ damage_dealt: 8000, match_id: 'match-first' });
    await recordDamageDealtMatchDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ damage_dealt: 7000, match_id: 'match-lower' });
    const events = await recordDamageDealtMatchDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('null damage_dealt → no event', async () => {
    const record = makeRecord({ damage_dealt: null });
    const events = await recordDamageDealtMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no event emitted', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, damage_dealt: 6840 });
    const events = await recordDamageDealtMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('same player beats own record → payload prev_puuid === current_puuid', async () => {
    const puuid = 'puuid-same';

    const firstRecord = makeRecord({ damage_dealt: 6000, match_id: 'match-first', riot_puuid: puuid });
    await recordDamageDealtMatchDetector.detect(firstRecord, [], { db });

    const betterRecord = makeRecord({ damage_dealt: 7500, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordDamageDealtMatchDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(7500);
    expect(events[0]!.payload.prev_value).toBe(6000);
    expect(events[0]!.payload.prev_puuid).toBe(puuid); // same player
  });
});
