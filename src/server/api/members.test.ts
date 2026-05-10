import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeMembersHandler } from './members.ts';
import { MembersResponseSchema, type Member } from '../../shared/schemas/members.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('makeMembersHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeApp(deps?: { refreshAvatarIfStale?: (id: number) => void }) {
    const app = new Hono();
    app.get('/api/members', makeMembersHandler({ db, ...deps }));
    return app;
  }

  it('returns 200 with empty array when no users', async () => {
    const app = makeApp();
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('returns users sorted: last_message_at DESC NULLS LAST, then joined_at ASC', async () => {
    const now = Date.now();

    // Insert users with specific timestamps to test ordering
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at) VALUES
        (1, 'alice', ${now - 1000}, ${now - 5000}),
        (2, 'bob',   ${now - 500},  ${now - 4000}),
        (3, 'carol', NULL,          ${now - 3000}),
        (4, 'dave',  NULL,          ${now - 2000})
    `);

    const app = makeApp();
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = await res.json() as Member[];
    const ids = body.map((m) => m.telegramId);
    // bob has most recent message, then alice, then carol (null, earlier join), then dave (null, later join)
    expect(ids).toEqual([2, 1, 3, 4]);
  });

  it('returns null for riotName/riotTag/currentRank when riot_puuid is NULL', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at) VALUES
        (1, 'alice', ${now}, ${now})
    `);

    const app = makeApp();
    const res = await app.request('/api/members');
    const body = await res.json() as Member[];
    expect(body).toHaveLength(1);
    const member = body[0]!;
    expect(member.riotName).toBeNull();
    expect(member.riotTag).toBeNull();
    expect(member.currentTierId).toBeNull();
    expect(member.currentTierName).toBeNull();
    expect(member.peakTierId).toBeNull();
    expect(member.peakTierName).toBeNull();
  });

  it('returns riotName/riotTag/tier fields for onboarded users', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (
        telegram_id, telegram_username, riot_puuid, riot_name, riot_tag,
        current_tier_id, current_tier_name, peak_tier_id, peak_tier_name, peak_season_short, mmr_fetched_at,
        last_message_at, joined_at
      )
      VALUES (
        1, 'alice', 'puuid-abc', 'Alice', '1337',
        17, 'Platinum 3', 21, 'Ascendant 1', 'e11a2', ${now},
        ${now}, ${now}
      )
    `);

    const app = makeApp();
    const res = await app.request('/api/members');
    const body = await res.json() as Member[];
    expect(body).toHaveLength(1);
    const member = body[0]!;
    expect(member.riotName).toBe('Alice');
    expect(member.riotTag).toBe('1337');
    expect(member.currentTierId).toBe(17);
    expect(member.currentTierName).toBe('Platinum 3');
    expect(member.peakTierId).toBe(21);
    expect(member.peakTierName).toBe('Ascendant 1');
    expect(member.peakSeasonShort).toBe('e11a2');
  });

  it('response validates against MembersResponseSchema', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, telegram_avatar_url, riot_puuid, riot_name, riot_tag, last_message_at, joined_at)
      VALUES (1, 'alice', 'https://example.com/avatar.jpg', 'puuid-abc', 'Alice', '1337', ${now}, ${now})
    `);

    const app = makeApp();
    const res = await app.request('/api/members');
    const body = await res.json();
    expect(() => MembersResponseSchema.parse(body)).not.toThrow();
  });

  it('converts lastMessageAt to ISO string', async () => {
    const now = 1715000000000; // fixed timestamp
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at) VALUES
        (1, 'alice', ${now}, ${now})
    `);

    const app = makeApp();
    const res = await app.request('/api/members');
    const body = await res.json() as Member[];
    expect(body[0]!.lastMessageAt).toBe(new Date(now).toISOString());
  });

  it('calls refreshAvatarIfStale for users with stale/missing avatar', async () => {
    const now = Date.now();
    const staleTimestamp = now - 25 * 60 * 60 * 1000; // 25 hours ago — stale

    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, telegram_avatar_fetched_at, last_message_at, joined_at)
      VALUES
        (1, 'alice', ${staleTimestamp}, ${now}, ${now}),
        (2, 'bob',   NULL,              ${now - 1000}, ${now})
    `);

    const refreshMock = vi.fn();
    const app = makeApp({ refreshAvatarIfStale: refreshMock });

    await app.request('/api/members');
    // Both alice (stale) and bob (never fetched) should trigger refresh
    expect(refreshMock).toHaveBeenCalledWith(1);
    expect(refreshMock).toHaveBeenCalledWith(2);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT call refreshAvatarIfStale for users with fresh avatar', async () => {
    const now = Date.now();
    const freshTimestamp = now - 60 * 1000; // 1 minute ago — fresh

    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, telegram_avatar_url, telegram_avatar_fetched_at, last_message_at, joined_at)
      VALUES (1, 'alice', 'https://example.com/pic.jpg', ${freshTimestamp}, ${now}, ${now})
    `);

    const refreshMock = vi.fn();
    const app = makeApp({ refreshAvatarIfStale: refreshMock });

    await app.request('/api/members');
    expect(refreshMock).not.toHaveBeenCalled();
  });

});
