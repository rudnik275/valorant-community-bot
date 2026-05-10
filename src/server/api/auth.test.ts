import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { makeAuthMiddleware } from './auth.ts';
import { InvalidInitDataError } from '../lib/init-data.ts';
import type { TelegramUser } from '../lib/init-data.ts';
import { users } from '../db/schema/users.ts';

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

const MOCK_USER: TelegramUser = {
  id: 42,
  username: 'alice',
  first_name: 'Alice',
};

function makeApp(verify: (raw: string) => TelegramUser, upsertUser?: (user: TelegramUser) => Promise<void>) {
  const app = new Hono();
  const deps = upsertUser ? { verify, upsertUser } : { verify };
  app.use('/api/*', makeAuthMiddleware(deps));
  app.get('/api/me', (c) => {
    const user = c.get('telegramUser');
    return c.json({ id: user.id, username: user.username });
  });
  return app;
}

describe('makeAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unauthorized');
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with "tma "', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'Bearer somejwt' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when verify throws InvalidInitDataError', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockImplementation(() => {
      throw new InvalidInitDataError('bad signature');
    });
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'tma invalid.raw.data' },
    });
    expect(res.status).toBe(401);
  });

  it('calls verify with the raw initData (after "tma ") and passes user downstream on success', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'tma raw_init_data_here' },
    });
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('raw_init_data_here');
    const body = await res.json() as { id: number; username: string };
    expect(body.id).toBe(42);
    expect(body.username).toBe('alice');
  });

  describe('upsertUser integration', () => {
    it('creates a new row for a brand-new telegram_id', async () => {
      const { db, sqlite } = makeTestDb();
      const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
      const upsertUser = async (user: TelegramUser) => {
        await db
          .insert(users)
          .values({ telegram_id: user.id, telegram_username: user.username ?? null })
          .onConflictDoUpdate({
            target: users.telegram_id,
            set: { telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})` },
          });
      };
      const app = makeApp(verify, upsertUser);

      const res = await app.request('/api/me', { headers: { Authorization: 'tma raw' } });
      expect(res.status).toBe(200);

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 10));

      const rows = sqlite.prepare('SELECT telegram_id, telegram_username FROM users WHERE telegram_id = 42').all() as Array<{ telegram_id: number; telegram_username: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.telegram_id).toBe(42);
      expect(rows[0]!.telegram_username).toBe('alice');

      sqlite.close();
    });

    it('does not overwrite existing username when initData has none (COALESCE preserves prior)', async () => {
      const { db, sqlite } = makeTestDb();

      // Pre-seed user with known-good username
      sqlite.exec(`INSERT INTO users (telegram_id, telegram_username) VALUES (42, 'prior_username')`);

      const userWithoutUsername: TelegramUser = { id: 42, first_name: 'Alice' };
      const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(userWithoutUsername);
      const upsertUser = async (user: TelegramUser) => {
        await db
          .insert(users)
          .values({ telegram_id: user.id, telegram_username: user.username ?? null })
          .onConflictDoUpdate({
            target: users.telegram_id,
            set: { telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})` },
          });
      };
      const app = makeApp(verify, upsertUser);

      await app.request('/api/me', { headers: { Authorization: 'tma raw' } });

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 10));

      const rows = sqlite.prepare('SELECT telegram_username FROM users WHERE telegram_id = 42').all() as Array<{ telegram_username: string | null }>;
      expect(rows[0]!.telegram_username).toBe('prior_username');

      sqlite.close();
    });

    it('preserves riot_puuid and other fields on existing user (no-op for non-username columns)', async () => {
      const { db, sqlite } = makeTestDb();

      // Pre-seed onboarded user
      sqlite.exec(`INSERT INTO users (telegram_id, telegram_username, riot_puuid) VALUES (42, 'alice', 'puuid-abc')`);

      const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
      const upsertUser = async (user: TelegramUser) => {
        await db
          .insert(users)
          .values({ telegram_id: user.id, telegram_username: user.username ?? null })
          .onConflictDoUpdate({
            target: users.telegram_id,
            set: { telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})` },
          });
      };
      const app = makeApp(verify, upsertUser);

      await app.request('/api/me', { headers: { Authorization: 'tma raw' } });

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 10));

      const rows = sqlite.prepare('SELECT telegram_username, riot_puuid FROM users WHERE telegram_id = 42').all() as Array<{ telegram_username: string | null; riot_puuid: string | null }>;
      expect(rows[0]!.riot_puuid).toBe('puuid-abc');
      expect(rows[0]!.telegram_username).toBe('alice');

      sqlite.close();
    });

    it('does not call upsertUser when auth fails', async () => {
      const verify = vi.fn<(raw: string) => TelegramUser>().mockImplementation(() => {
        throw new InvalidInitDataError('bad sig');
      });
      const upsertUser = vi.fn<(user: TelegramUser) => Promise<void>>().mockResolvedValue(undefined);
      const app = makeApp(verify, upsertUser);

      const res = await app.request('/api/me', { headers: { Authorization: 'tma bad' } });
      expect(res.status).toBe(401);
      expect(upsertUser).not.toHaveBeenCalled();
    });

    it('still returns 200 when upsertUser throws (fire-and-forget, never blocks request)', async () => {
      const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
      const upsertUser = vi.fn<(user: TelegramUser) => Promise<void>>().mockRejectedValue(new Error('DB exploded'));
      const app = makeApp(verify, upsertUser);

      const res = await app.request('/api/me', { headers: { Authorization: 'tma raw' } });
      expect(res.status).toBe(200);
    });
  });
});
