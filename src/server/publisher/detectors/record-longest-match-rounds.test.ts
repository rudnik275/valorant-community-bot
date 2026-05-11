import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordLongestMatchRoundsDetector } from './record-longest-match-rounds.ts';
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
    rounds_played: 30,
    rank_before: null,
    rank_after: 'Diamond 1',
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: '[]',
    rounds_compact: null,
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

describe('recordLongestMatchRoundsDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('new record (no previous) → emits event with prev_value=null', async () => {
    const record = makeRecord({ rounds_played: 30 });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_longest_match_rounds');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(30);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
  });

  it('new record beats existing → emits with prev_value', async () => {
    const firstRecord = makeRecord({ rounds_played: 25, match_id: 'match-first', riot_puuid: 'puuid-first' });
    await recordLongestMatchRoundsDetector.detectAsync!(firstRecord, [], { db });

    const newRecord = makeRecord({ rounds_played: 40, match_id: 'match-new', riot_puuid: 'puuid-new' });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(newRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(40);
    expect(events[0]!.payload.prev_value).toBe(25);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
  });

  it('value lower than existing → no event', async () => {
    const firstRecord = makeRecord({ rounds_played: 40, match_id: 'match-first' });
    await recordLongestMatchRoundsDetector.detectAsync!(firstRecord, [], { db });

    const lowerRecord = makeRecord({ rounds_played: 25, match_id: 'match-lower' });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(lowerRecord, [], { db });

    expect(events).toHaveLength(0);
  });

  it('same player beats own record → prev_puuid === current puuid', async () => {
    const puuid = 'puuid-same';
    const firstRecord = makeRecord({ rounds_played: 25, match_id: 'match-first', riot_puuid: puuid });
    await recordLongestMatchRoundsDetector.detectAsync!(firstRecord, [], { db });

    const betterRecord = makeRecord({ rounds_played: 40, match_id: 'match-better', riot_puuid: puuid });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.prev_puuid).toBe(puuid);
  });

  it('null riot_puuid → no event', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('zero rounds_played → no event', async () => {
    const record = makeRecord({ rounds_played: 0 });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('community_players populated from match_rosters + users', async () => {
    const matchId = 'match-community';
    seedUser(sqlite, 'puuid-a', 'PlayerA', 'AAA');
    seedUser(sqlite, 'puuid-b', 'PlayerB', 'BBB');
    seedUser(sqlite, 'puuid-c', 'PlayerC', 'CCC');
    seedMatchRoster(sqlite, matchId, 'puuid-a', 'Blue');
    seedMatchRoster(sqlite, matchId, 'puuid-b', 'Red');
    seedMatchRoster(sqlite, matchId, 'puuid-c', 'Blue');

    const record = makeRecord({ rounds_played: 30, match_id: matchId, riot_puuid: 'puuid-test' });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    const players = events[0]!.payload.community_players as Array<{ puuid: string; name: string; tag: string }>;
    expect(Array.isArray(players)).toBe(true);
    expect(players).toHaveLength(3);
    expect(players.some((p) => p.name === 'PlayerA')).toBe(true);
    expect(players.some((p) => p.name === 'PlayerB')).toBe(true);
    expect(players.some((p) => p.name === 'PlayerC')).toBe(true);
  });

  it('no match_rosters → community_players is empty array', async () => {
    const record = makeRecord({ rounds_played: 30 });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    const players = events[0]!.payload.community_players as Array<unknown>;
    expect(players).toHaveLength(0);
  });

  it('prev_name/prev_tag fetched from users table when previous holder exists', async () => {
    const prevPuuid = 'puuid-prev-holder';
    seedUser(sqlite, prevPuuid, 'MarathonKing', 'MRK');

    const firstRecord = makeRecord({ rounds_played: 25, match_id: 'match-first', riot_puuid: prevPuuid });
    await recordLongestMatchRoundsDetector.detectAsync!(firstRecord, [], { db });

    const betterRecord = makeRecord({ rounds_played: 40, match_id: 'match-better', riot_puuid: 'puuid-new' });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(betterRecord, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.prev_name).toBe('MarathonKing');
    expect(events[0]!.payload.prev_tag).toBe('MRK');
  });

  it('multi-player community renders correctly', async () => {
    const matchId = 'match-multi';
    seedUser(sqlite, 'puuid-x', 'Xena', 'XEN');
    seedUser(sqlite, 'puuid-y', 'Yuri', 'YUR');
    seedMatchRoster(sqlite, matchId, 'puuid-x');
    seedMatchRoster(sqlite, matchId, 'puuid-y');

    const record = makeRecord({ rounds_played: 35, match_id: matchId });
    const events = await recordLongestMatchRoundsDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    const cp = events[0]!.payload.community_players as Array<{ name: string }>;
    expect(cp.length).toBe(2);
  });
});
