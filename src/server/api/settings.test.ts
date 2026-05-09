import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeSettingsHandlers } from './settings.ts';
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

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const MOCK_USER: TelegramUser = { id: 12345, first_name: 'Test', username: 'testuser' };

function makeApp(
  db: ReturnType<typeof makeTestDb>['db'],
  telegramUser: TelegramUser = MOCK_USER,
) {
  const app = new Hono();
  // Inject telegramUser into context (simulating auth middleware)
  app.use('/api/me/settings', async (c, next) => {
    c.set('telegramUser', telegramUser);
    await next();
  });
  const { getSettings, patchSettings } = makeSettingsHandlers({ db });
  app.get('/api/me/settings', getSettings);
  app.patch('/api/me/settings', patchSettings);
  return app;
}

describe('makeSettingsHandlers', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    // Insert the user row so FK constraint is satisfied
    sqlite.exec(`INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at) VALUES (12345, 'testuser', ${Date.now()}, ${Date.now()})`);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('GET with no opt_outs row returns {chatRealtimeDisabled: false}', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/me/settings');
    expect(res.status).toBe(200);
    const body = await res.json() as { chatRealtimeDisabled: boolean };
    expect(body).toEqual({ chatRealtimeDisabled: false });
  });

  it('GET with existing row chat_realtime_disabled=1 returns {chatRealtimeDisabled: true}', async () => {
    sqlite.exec(`INSERT INTO opt_outs (telegram_id, chat_realtime_disabled) VALUES (12345, 1)`);
    const app = makeApp(db);
    const res = await app.request('/api/me/settings');
    expect(res.status).toBe(200);
    const body = await res.json() as { chatRealtimeDisabled: boolean };
    expect(body).toEqual({ chatRealtimeDisabled: true });
  });

  it('PATCH true inserts row and returns {chatRealtimeDisabled: true}', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatRealtimeDisabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { chatRealtimeDisabled: boolean };
    expect(body).toEqual({ chatRealtimeDisabled: true });

    // Verify the row was actually written
    const row = sqlite.prepare('SELECT chat_realtime_disabled FROM opt_outs WHERE telegram_id = 12345').get() as { chat_realtime_disabled: number } | undefined;
    expect(row?.chat_realtime_disabled).toBe(1);
  });

  it('PATCH false updates row and returns {chatRealtimeDisabled: false}', async () => {
    // Pre-seed row with true
    sqlite.exec(`INSERT INTO opt_outs (telegram_id, chat_realtime_disabled) VALUES (12345, 1)`);

    const app = makeApp(db);
    const res = await app.request('/api/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatRealtimeDisabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { chatRealtimeDisabled: boolean };
    expect(body).toEqual({ chatRealtimeDisabled: false });

    // Verify the row was actually updated
    const row = sqlite.prepare('SELECT chat_realtime_disabled FROM opt_outs WHERE telegram_id = 12345').get() as { chat_realtime_disabled: number } | undefined;
    expect(row?.chat_realtime_disabled).toBe(0);
  });

  it('PATCH with invalid body (wrong type) returns 400', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatRealtimeDisabled: 'yes' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('PATCH with missing field returns 400', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });
});
