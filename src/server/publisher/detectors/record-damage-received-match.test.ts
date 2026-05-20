import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordDamageReceivedMatchDetector } from './record-damage-received-match.ts';
import { renderTemplate } from '../templates.ts';
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
    kills: 10,
    deaths: 20,
    assists: 2,
    result: 'loss',
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
    damage_received: 5910,
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    inserted_at: 1750000000000,
    ...overrides,
  };
}

describe('recordDamageReceivedMatchDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new value > nothing → emits event with prev_value=null', async () => {
    const record = makeRecord({ damage_received: 5910 });
    const events = await recordDamageReceivedMatchDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_damage_received_match');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(5910);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new value > existing → emits with prev_value and prev_name set', async () => {
    const firstRecord = makeRecord({ damage_received: 5000, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordDamageReceivedMatchDetector.detect(firstRecord, [], { db });

    const newRecord = makeRecord({ damage_received: 6200, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordDamageReceivedMatchDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(6200);
    expect(events[0]!.payload.prev_value).toBe(5000);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    expect(events[0]!.payload).toHaveProperty('prev_name');
    expect(events[0]!.payload).toHaveProperty('prev_tag');
  });

  it('new value <= existing → no event', async () => {
    const firstRecord = makeRecord({ damage_received: 7000, match_id: 'match-first' });
    await recordDamageReceivedMatchDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ damage_received: 5000, match_id: 'match-lower' });
    const events = await recordDamageReceivedMatchDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('null damage_received → no event', async () => {
    const record = makeRecord({ damage_received: null });
    const events = await recordDamageReceivedMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no event emitted', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, damage_received: 5910 });
    const events = await recordDamageReceivedMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('same player beats own damage_received record → payload prev_puuid === current_puuid', async () => {
    const puuid = 'puuid-same';

    const firstRecord = makeRecord({ damage_received: 5000, match_id: 'match-first', riot_puuid: puuid });
    await recordDamageReceivedMatchDetector.detect(firstRecord, [], { db });

    const betterRecord = makeRecord({ damage_received: 6500, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordDamageReceivedMatchDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(6500);
    expect(events[0]!.payload.prev_value).toBe(5000);
    expect(events[0]!.payload.prev_puuid).toBe(puuid); // same player
  });

  it('same-player self-record: template does NOT render "тоже его" or prev value (prev-record removed per user)', () => {
    const puuid = 'puuid-same';
    const output = renderTemplate(
      'record_damage_received_match',
      {
        value: 6500,
        prev_value: 5000,
        prev_puuid: puuid,
        prev_name: 'Player',
        prev_tag: 'TAG',
      },
      { riot_name: 'Player', riot_tag: 'TAG', telegram_id: 12345, riot_puuid: puuid },
    );
    expect(output).not.toContain('тоже его');
    expect(output).not.toContain('5000');
    expect(output).not.toContain('прошлый рекорд');
  });
});
