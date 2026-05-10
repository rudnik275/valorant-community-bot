import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeOnboardHandler } from './onboard.ts';
import {
  HenrikNotFoundError,
  HenrikRateLimitError,
  HenrikUpstreamError,
  type RiotAccount,
} from '../lib/henrik.ts';
import type { TelegramUser } from '../lib/init-data.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const MOCK_USER: TelegramUser = { id: 42, first_name: 'Test', username: 'testuser' };

const MOCK_ACCOUNT: RiotAccount = {
  puuid: 'puuid-abc-123',
  name: 'TestPlayer',
  tag: 'EU1',
  region: 'eu',
  cardId: null,
};

function makeApp(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: {
    telegramUser?: TelegramUser;
    validateAccount?: (name: string, tag: string) => Promise<RiotAccount>;
    scanForPuuid?: (puuid: string, opts: { detection: boolean }) => Promise<unknown>;
  } = {},
) {
  const app = new Hono();
  // Simulate auth middleware setting telegramUser on context
  app.use('/api/onboard', async (c, next) => {
    c.set('telegramUser', overrides.telegramUser ?? MOCK_USER);
    await next();
  });
  app.post(
    '/api/onboard',
    makeOnboardHandler({
      db,
      validateAccount: overrides.validateAccount ?? vi.fn().mockResolvedValue(MOCK_ACCOUNT),
      scanForPuuid: overrides.scanForPuuid ?? vi.fn().mockResolvedValue(undefined),
    }),
  );
  return app;
}

function postOnboard(app: Hono, body: unknown) {
  return app.request('/api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/onboard', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    // Seed the user row so FK constraint is satisfied
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at)
       VALUES (42, 'testuser', ${Date.now()}, ${Date.now()})`,
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with account data on success', async () => {
    const app = makeApp(db);
    const res = await postOnboard(app, { name: 'TestPlayer', tag: 'EU1' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.riot_name).toBe('TestPlayer');
    expect(body.riot_tag).toBe('EU1');
    expect(body.riot_puuid).toBe('puuid-abc-123');
    expect(body.riot_region).toBe('eu');
  });

  it('persists riot fields to the users table', async () => {
    const app = makeApp(db);
    await postOnboard(app, { name: 'TestPlayer', tag: 'EU1' });

    const row = sqlite
      .prepare('SELECT riot_puuid, riot_name, riot_tag, riot_region, onboarded_at FROM users WHERE telegram_id = 42')
      .get() as { riot_puuid: string; riot_name: string; riot_tag: string; riot_region: string; onboarded_at: number };

    expect(row.riot_puuid).toBe('puuid-abc-123');
    expect(row.riot_name).toBe('TestPlayer');
    expect(row.riot_tag).toBe('EU1');
    expect(row.riot_region).toBe('eu');
    expect(row.onboarded_at).toBeGreaterThan(0);
  });

  it('calls scanForPuuid fire-and-forget after success', async () => {
    const scanMock = vi.fn().mockResolvedValue(undefined);
    const app = makeApp(db, { scanForPuuid: scanMock });
    await postOnboard(app, { name: 'TestPlayer', tag: 'EU1' });

    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(scanMock).toHaveBeenCalledWith('puuid-abc-123', { detection: false });
  });

  it('UPSERTs on re-onboard — updates existing riot fields', async () => {
    // First onboard
    const app = makeApp(db);
    await postOnboard(app, { name: 'TestPlayer', tag: 'EU1' });

    // Second onboard with different account
    const newAccount: RiotAccount = { puuid: 'puuid-xyz-999', name: 'NewName', tag: 'NA1', region: 'na', cardId: null };
    const app2 = makeApp(db, { validateAccount: vi.fn().mockResolvedValue(newAccount) });
    const res2 = await postOnboard(app2, { name: 'NewName', tag: 'NA1' });

    expect(res2.status).toBe(200);
    const row = sqlite
      .prepare('SELECT riot_puuid, riot_name FROM users WHERE telegram_id = 42')
      .get() as { riot_puuid: string; riot_name: string };
    expect(row.riot_puuid).toBe('puuid-xyz-999');
    expect(row.riot_name).toBe('NewName');
  });

  // ── Error: HenrikNotFoundError ───────────────────────────────────────────────

  it('returns 404 { error: "account_not_found" } when Henrik returns not found', async () => {
    const app = makeApp(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikNotFoundError()),
    });
    const res = await postOnboard(app, { name: 'Ghost', tag: 'X1' });

    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('account_not_found');
  });

  // ── Error: HenrikRateLimitError ──────────────────────────────────────────────

  it('returns 429 { error: "rate_limited", retry_after } when Henrik rate-limits', async () => {
    const app = makeApp(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikRateLimitError(30)),
    });
    const res = await postOnboard(app, { name: 'Player', tag: 'EU1' });

    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBe(30);
  });

  // ── Error: HenrikUpstreamError ───────────────────────────────────────────────

  it('returns 502 { error: "henrik_upstream" } on Henrik 5xx', async () => {
    const app = makeApp(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikUpstreamError(503, 'Service Unavailable')),
    });
    const res = await postOnboard(app, { name: 'Player', tag: 'EU1' });

    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('henrik_upstream');
  });

  // ── Error: puuid_already_linked ──────────────────────────────────────────────

  it('returns 409 { error: "puuid_already_linked" } when riot_puuid belongs to another telegram user', async () => {
    // Insert another user who already owns the same puuid
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, riot_region, onboarded_at, joined_at)
       VALUES (99, 'otheruser', 'puuid-abc-123', 'TestPlayer', 'EU1', 'eu', ${Date.now()}, ${Date.now()})`,
    );

    const app = makeApp(db);
    const res = await postOnboard(app, { name: 'TestPlayer', tag: 'EU1' });

    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('puuid_already_linked');
  });

  // ── Validation: malformed body ───────────────────────────────────────────────

  it('returns 400 on empty body', async () => {
    const app = makeApp(db);
    const res = await postOnboard(app, {});

    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('invalid_body');
  });

  it('returns 400 when name exceeds 16 chars', async () => {
    const app = makeApp(db);
    const res = await postOnboard(app, { name: 'A'.repeat(17), tag: 'EU1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when tag exceeds 5 chars', async () => {
    const app = makeApp(db);
    const res = await postOnboard(app, { name: 'Player', tag: 'TOOLONG' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when tag contains non-alphanumeric characters', async () => {
    const app = makeApp(db);
    const res = await postOnboard(app, { name: 'Player', tag: 'EU#1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
  });
});
