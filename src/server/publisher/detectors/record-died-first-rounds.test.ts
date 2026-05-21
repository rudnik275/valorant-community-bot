import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordDiedFirstRoundsDetector } from './record-died-first-rounds.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
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
    kills: 10,
    deaths: 15,
    assists: 2,
    result: 'loss',
    rounds_played: 20,
    rank_before: null,
    rank_after: null,
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
    survived_last_rounds: null,
    died_first_rounds: null,
    inserted_at: 1750000000000,
    ...overrides,
  };
}

function seedUser(sqlite: Database.Database, puuid: string, riotName: string, riotTag: string) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Math.floor(Math.random() * 100000), puuid, riotName, riotTag, Date.now());
}

describe('recordDiedFirstRoundsDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('null died_first_rounds → no event (no signal in match)', async () => {
    const record = makeRecord({ died_first_rounds: null });
    const events = await recordDiedFirstRoundsDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('first record (no prev) → emits with prev_value=null', async () => {
    const record = makeRecord({ died_first_rounds: 3 });
    const events = await recordDiedFirstRoundsDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_died_first_rounds');
    expect(events[0]!.payload.value).toBe(3);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('beats existing record → emits with prev_value and prev_name', async () => {
    seedUser(sqlite, 'puuid-first', 'FirstPlayer', 'FIRST');

    const firstRecord = makeRecord({ died_first_rounds: 4, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordDiedFirstRoundsDetector.detect(firstRecord, [], { db });

    const newRecord = makeRecord({ died_first_rounds: 6, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordDiedFirstRoundsDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(6);
    expect(events[0]!.payload.prev_value).toBe(4);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    expect(events[0]!.payload.prev_name).toBe('FirstPlayer');
    expect(events[0]!.payload.prev_tag).toBe('FIRST');
  });

  it('does not beat existing record → no event', async () => {
    const firstRecord = makeRecord({ died_first_rounds: 8, match_id: 'match-first' });
    await recordDiedFirstRoundsDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ died_first_rounds: 5, match_id: 'match-lower' });
    const events = await recordDiedFirstRoundsDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('ties existing record → no event (strict >)', async () => {
    const firstRecord = makeRecord({ died_first_rounds: 5, match_id: 'match-first' });
    await recordDiedFirstRoundsDetector.detect(firstRecord, [], { db });

    const tieRecord = makeRecord({ died_first_rounds: 5, match_id: 'match-tie' });
    const events = await recordDiedFirstRoundsDetector.detect(tieRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no event', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, died_first_rounds: 5 });
    const events = await recordDiedFirstRoundsDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
