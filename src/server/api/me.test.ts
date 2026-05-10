import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeMeHandler } from './me.ts';
import type { TelegramUser } from '../lib/init-data.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

interface MeProfile {
  telegramId: number;
  riotName: string | null;
  riotTag: string | null;
  riotPuuid: string | null;
  currentRank: { tierId: number; tierName: string } | null;
  peakRank: { tierId: number; tierName: string; seasonShort: string | null } | null;
  region: string | null;
}

interface MeResponse {
  onboarded: boolean;
  profile: MeProfile | null;
}

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const MOCK_USER: TelegramUser = { id: 12345, first_name: 'Test', username: 'testuser' };

function makeApp(db: ReturnType<typeof makeTestDb>['db'], telegramUser: TelegramUser = MOCK_USER) {
  const app = new Hono();
  // Inject telegramUser into context (simulating auth middleware)
  app.use('/api/me', async (c, next) => {
    c.set('telegramUser', telegramUser);
    await next();
  });
  app.get('/api/me', makeMeHandler({ db }));
  return app;
}

describe('makeMeHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns {onboarded: false, profile: null} when user has no row in DB', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body).toEqual({ onboarded: false, profile: null });
  });

  it('returns {onboarded: false} when user row exists but riot_puuid is null', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at)
      VALUES (12345, 'testuser', ${now}, ${now})
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.onboarded).toBe(false);
    // Profile is still returned (user exists but not onboarded)
    expect(body.profile).toBeTruthy();
    expect(body.profile?.riotPuuid).toBeNull();
  });

  it('returns {onboarded: false} when riot_puuid is set but onboarded_at is null', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, joined_at)
      VALUES (12345, 'testuser', 'some-puuid', 'TestPlayer', 'EU1', ${now})
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.onboarded).toBe(false);
  });

  it('returns {onboarded: true, profile} for fully onboarded user', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (12345, 'testuser', 'puuid-abc-123', 'TestPlayer', 'EU1', ${now}, ${now})
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.onboarded).toBe(true);
    expect(body.profile).toMatchObject({
      telegramId: 12345,
      riotName: 'TestPlayer',
      riotTag: 'EU1',
      riotPuuid: 'puuid-abc-123',
    });
  });

  it('returns profile for the correct user (not others)', async () => {
    const now = Date.now();
    // Insert two users; only one matches the telegramUser
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES
        (12345, 'testuser', 'puuid-12345', 'RightPlayer', 'EU1', ${now}, ${now}),
        (99999, 'otheruser', 'puuid-99999', 'WrongPlayer', 'EU2', ${now}, ${now})
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.profile?.riotName).toBe('RightPlayer');
    expect(body.profile?.riotPuuid).toBe('puuid-12345');
  });

  it('returns currentRank, peakRank, and region when rank columns are set', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (
        telegram_id, telegram_username, riot_puuid, riot_name, riot_tag,
        onboarded_at, joined_at,
        current_tier_id, current_tier_name,
        peak_tier_id, peak_tier_name, peak_season_short,
        riot_region
      )
      VALUES (
        12345, 'testuser', 'puuid-abc', 'TestPlayer', 'EU1',
        ${now}, ${now},
        17, 'Platinum 3',
        21, 'Ascendant 1', 'e11a2',
        'eu'
      )
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.profile?.currentRank).toEqual({ tierId: 17, tierName: 'Platinum 3' });
    expect(body.profile?.peakRank).toEqual({ tierId: 21, tierName: 'Ascendant 1', seasonShort: 'e11a2' });
    expect(body.profile?.region).toBe('eu');
  });

  it('returns null currentRank, peakRank, and region when rank columns are null', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (12345, 'testuser', 'puuid-abc', 'TestPlayer', 'EU1', ${now}, ${now})
    `);

    const app = makeApp(db);
    const res = await app.request('/api/me');
    expect(res.status).toBe(200);
    const body = await res.json() as MeResponse;
    expect(body.profile?.currentRank).toBeNull();
    expect(body.profile?.peakRank).toBeNull();
    expect(body.profile?.region).toBeNull();
  });
});
