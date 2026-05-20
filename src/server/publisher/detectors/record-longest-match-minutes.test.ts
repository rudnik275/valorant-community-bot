import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordLongestMatchMinutesDetector } from './record-longest-match-minutes.ts';
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
    kills: 15,
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
    game_length_ms: 2700000,  // 45 minutes
    is_match_mvp: null,
    inserted_at: 1750000000000,
    ...overrides,
  };
}

function seedUser(sqlite: Database.Database, puuid: string, name: string, tag: string) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(Math.floor(Math.random() * 1000000), puuid, name, tag, Date.now());
}

function seedMatchRoster(sqlite: Database.Database, matchId: string, puuid: string, team = 'Blue') {
  sqlite.prepare(
    `INSERT OR REPLACE INTO match_rosters (match_id, riot_puuid, team) VALUES (?, ?, ?)`,
  ).run(matchId, puuid, team);
}

describe('recordLongestMatchMinutesDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new record (no previous) → emits event with prev_value=null', async () => {
    const record = makeRecord({ game_length_ms: 2700000 }); // 45 min
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_longest_match_minutes');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(45);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new record beats existing → emits with prev_value', async () => {
    const firstRecord = makeRecord({ game_length_ms: 2400000, match_id: 'match-first', riot_puuid: 'puuid-first' }); // 40 min
    await recordLongestMatchMinutesDetector.detect(firstRecord, [], { db });

    const newRecord = makeRecord({ game_length_ms: 3000000, match_id: 'match-new', riot_puuid: 'puuid-new' }); // 50 min
    const events = await recordLongestMatchMinutesDetector.detect(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(50);
    expect(events[0]!.payload.prev_value).toBe(40);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
  });

  it('value lower than existing → no event', async () => {
    const firstRecord = makeRecord({ game_length_ms: 3600000, match_id: 'match-first' }); // 60 min
    await recordLongestMatchMinutesDetector.detect(firstRecord, [], { db });

    const lowerRecord = makeRecord({ game_length_ms: 2700000, match_id: 'match-lower' }); // 45 min
    const events = await recordLongestMatchMinutesDetector.detect(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('same player beats own record → prev_puuid === current puuid', async () => {
    const puuid = 'puuid-same';
    const firstRecord = makeRecord({ game_length_ms: 2400000, match_id: 'match-first', riot_puuid: puuid });
    await recordLongestMatchMinutesDetector.detect(firstRecord, [], { db });

    const betterRecord = makeRecord({ game_length_ms: 3000000, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordLongestMatchMinutesDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.prev_puuid).toBe(puuid);
  });

  it('null riot_puuid → no event', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string });
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null game_length_ms → no event', async () => {
    const record = makeRecord({ game_length_ms: null });
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('zero game_length_ms → no event', async () => {
    const record = makeRecord({ game_length_ms: 0 });
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('community_players populated from match_rosters + users', async () => {
    const matchId = 'match-community';
    seedUser(sqlite, 'puuid-a', 'PlayerA', 'AAA');
    seedUser(sqlite, 'puuid-b', 'PlayerB', 'BBB');
    seedMatchRoster(sqlite, matchId, 'puuid-a', 'Blue');
    seedMatchRoster(sqlite, matchId, 'puuid-b', 'Blue');
    // puuid-test is the recorder but NOT in rosters (only community known players are listed)

    const record = makeRecord({ game_length_ms: 2700000, match_id: matchId, riot_puuid: 'puuid-test' });
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    const players = events[0]!.payload.community_players as Array<{ puuid: string; name: string; tag: string }>;
    expect(Array.isArray(players)).toBe(true);
    expect(players).toHaveLength(2);
    expect(players.some((p) => p.name === 'PlayerA')).toBe(true);
    expect(players.some((p) => p.name === 'PlayerB')).toBe(true);
  });

  it('no match_rosters → community_players is empty array', async () => {
    const record = makeRecord({ game_length_ms: 2700000 });
    const events = await recordLongestMatchMinutesDetector.detect(record, [], { db });

    expect(events).toHaveLength(1);
    const players = events[0]!.payload.community_players as Array<unknown>;
    expect(players).toHaveLength(0);
  });

  it('prev_name/prev_tag fetched from users table when previous holder exists', async () => {
    const prevPuuid = 'puuid-prev-holder';
    seedUser(sqlite, prevPuuid, 'OldChamp', 'OCC');

    const firstRecord = makeRecord({ game_length_ms: 2400000, match_id: 'match-first', riot_puuid: prevPuuid });
    await recordLongestMatchMinutesDetector.detect(firstRecord, [], { db });

    const betterRecord = makeRecord({ game_length_ms: 3000000, match_id: 'match-better', riot_puuid: 'puuid-new' });
    const events = await recordLongestMatchMinutesDetector.detect(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.prev_name).toBe('OldChamp');
    expect(events[0]!.payload.prev_tag).toBe('OCC');
  });
});
