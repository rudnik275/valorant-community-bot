import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordSurvivedLastRoundsDetector } from './record-survived-last-rounds.ts';
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

describe('recordSurvivedLastRoundsDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('null survived_last_rounds → no event (no signal in match)', async () => {
    const record = makeRecord({ survived_last_rounds: null });
    const events = await recordSurvivedLastRoundsDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('first record (no prev) → emits with prev_value=null', async () => {
    const record = makeRecord({ survived_last_rounds: 3 });
    const events = await recordSurvivedLastRoundsDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_survived_last_rounds');
    expect(events[0]!.payload.value).toBe(3);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('beats existing record → emits with prev_value and prev_name', async () => {
    seedUser(sqlite, 'puuid-first', 'FirstPlayer', 'FIRST');

    const firstRecord = makeRecord({ survived_last_rounds: 4, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordSurvivedLastRoundsDetector.detect(firstRecord, [], { db });

    const newRecord = makeRecord({ survived_last_rounds: 6, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordSurvivedLastRoundsDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(6);
    expect(events[0]!.payload.prev_value).toBe(4);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    expect(events[0]!.payload.prev_name).toBe('FirstPlayer');
    expect(events[0]!.payload.prev_tag).toBe('FIRST');
  });

  it('does not beat existing record → no event', async () => {
    const firstRecord = makeRecord({ survived_last_rounds: 8, match_id: 'match-first' });
    await recordSurvivedLastRoundsDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ survived_last_rounds: 5, match_id: 'match-lower' });
    const events = await recordSurvivedLastRoundsDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('ties existing record → no event (strict >)', async () => {
    const firstRecord = makeRecord({ survived_last_rounds: 5, match_id: 'match-first' });
    await recordSurvivedLastRoundsDetector.detect(firstRecord, [], { db });

    const tieRecord = makeRecord({ survived_last_rounds: 5, match_id: 'match-tie' });
    const events = await recordSurvivedLastRoundsDetector.detect(tieRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no event', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, survived_last_rounds: 5 });
    const events = await recordSurvivedLastRoundsDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
