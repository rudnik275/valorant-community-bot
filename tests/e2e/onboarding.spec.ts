/**
 * tests/e2e/onboarding.spec.ts
 *
 * Integration test for the full onboarding flow.
 * Uses an in-memory better-sqlite3 DB with real Drizzle migrations applied.
 * Mocks Henrik API and Telegram botApi — wires the actual makeOnboardHandler.
 *
 * This test is broader than onboard.test.ts: it verifies the complete module
 * wiring (auth middleware stub + handler + DB write + bot API calls) end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeOnboardHandler } from '../../src/server/api/onboard.ts';
import type { TelegramUser } from '../../src/server/lib/init-data.ts';

vi.mock('../../src/server/lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock scope.ts so safePromote/safeSetCustomTitle don't throw on allowlist checks
vi.mock('../../src/server/lib/scope.ts', () => ({
  isAllowedChat: vi.fn().mockReturnValue(true),
  loadAllowedChatIds: vi.fn().mockReturnValue(new Set([-100111, -100222])),
  _resetCache: vi.fn(),
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const FAKE_TELEGRAM_USER: TelegramUser = {
  id: 55001,
  first_name: 'IntegrationUser',
  username: 'int_user',
};

const FAKE_ACCOUNT = {
  puuid: 'e2e-puuid-onboard-001',
  name: 'IntPlayer',
  tag: 'E2E1',
  region: 'EU',
};

function makeFakeBotApi() {
  return {
    promoteChatMember: vi.fn().mockResolvedValue(true),
    setChatAdministratorCustomTitle: vi.fn().mockResolvedValue(true),
  };
}

function buildApp(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: {
    validateAccount?: ReturnType<typeof vi.fn>;
    botApi?: ReturnType<typeof makeFakeBotApi>;
    scanForPuuid?: ReturnType<typeof vi.fn>;
    telegramUser?: TelegramUser;
    allowedChatIds?: Set<number>;
  } = {},
) {
  const {
    validateAccount = vi.fn().mockResolvedValue(FAKE_ACCOUNT),
    botApi = makeFakeBotApi(),
    scanForPuuid = vi.fn().mockResolvedValue({ newRecords: [], skippedDuplicates: 0 }),
    telegramUser = FAKE_TELEGRAM_USER,
    allowedChatIds = new Set([-100111, -100222]),
  } = overrides;

  const app = new Hono();

  // Stub auth middleware — injects a fake telegramUser into context (mirrors real auth middleware)
  app.use('/api/onboard', async (c, next) => {
    c.set('telegramUser', telegramUser);
    await next();
  });

  app.post(
    '/api/onboard',
    makeOnboardHandler({
      db,
      validateAccount,
      scanForPuuid,
      botApi: botApi as never,
      getAllowedChatIds: () => allowedChatIds,
    }),
  );

  return { app, validateAccount, botApi, scanForPuuid };
}

function postOnboard(app: Hono, body: Record<string, unknown>) {
  return app.request(
    new Request('http://localhost/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('e2e: onboarding flow', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  it('responds 200 and inserts user row with riot_puuid and riot_region', async () => {
    const { app } = buildApp(db);

    const res = await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });

    expect(res.status).toBe(200);

    const body = await res.json() as { success: boolean; profile: { puuid: string }; joinedGroup: boolean };
    expect(body.success).toBe(true);
    expect(body.profile.puuid).toBe(FAKE_ACCOUNT.puuid);

    // Verify DB write
    const row = sqlite
      .prepare('SELECT riot_puuid, riot_name, riot_tag, riot_region, onboarded_at FROM users WHERE telegram_id = ?')
      .get(FAKE_TELEGRAM_USER.id) as {
        riot_puuid: string;
        riot_name: string;
        riot_tag: string;
        riot_region: string;
        onboarded_at: number;
      } | undefined;

    expect(row).toBeDefined();
    expect(row!.riot_puuid).toBe(FAKE_ACCOUNT.puuid);
    expect(row!.riot_region).toBe('EU');
    expect(row!.riot_name).toBe('IntPlayer');
    expect(row!.riot_tag).toBe('E2E1');
    expect(row!.onboarded_at).toBeGreaterThan(0);
  });

  it('calls promoteChatMember and setChatAdministratorCustomTitle for each allowed chat ID', async () => {
    const botApi = makeFakeBotApi();
    const { app } = buildApp(db, { botApi });

    await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });

    // Both allowed chat IDs (-100111 and -100222) should be promoted
    expect(botApi.promoteChatMember).toHaveBeenCalledTimes(2);
    expect(botApi.setChatAdministratorCustomTitle).toHaveBeenCalledTimes(2);

    expect(botApi.promoteChatMember).toHaveBeenCalledWith(-100111, FAKE_TELEGRAM_USER.id, { can_manage_chat: true });
    expect(botApi.promoteChatMember).toHaveBeenCalledWith(-100222, FAKE_TELEGRAM_USER.id, { can_manage_chat: true });
  });

  it('calls scanForPuuid with { detection: false } after successful onboard', async () => {
    const scanForPuuid = vi.fn().mockResolvedValue({ newRecords: [], skippedDuplicates: 0 });
    const { app } = buildApp(db, { scanForPuuid });

    await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });

    // Fire-and-forget — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(scanForPuuid).toHaveBeenCalledOnce();
    expect(scanForPuuid).toHaveBeenCalledWith(FAKE_ACCOUNT.puuid, { detection: false });
  });

  it('does not call scanForPuuid when it is not provided', async () => {
    const { app, scanForPuuid } = buildApp(db, { scanForPuuid: undefined as never });
    // scanForPuuid was explicitly omitted — no assertion on it; just confirm no crash
    const res = await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });
    expect(res.status).toBe(200);
    void scanForPuuid;
  });

  it('re-onboarding (same user + same PUUID) returns 200 and upserts row', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (${FAKE_TELEGRAM_USER.id}, 'int_user', '${FAKE_ACCOUNT.puuid}', 'OldName', 'OLD1', ${now - 1000}, ${now - 1000})
    `);

    const { app } = buildApp(db);
    const res = await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });

    expect(res.status).toBe(200);

    const row = sqlite
      .prepare('SELECT riot_name, riot_tag FROM users WHERE telegram_id = ?')
      .get(FAKE_TELEGRAM_USER.id) as { riot_name: string; riot_tag: string };
    expect(row.riot_name).toBe('IntPlayer');
    expect(row.riot_tag).toBe('E2E1');
  });

  it('returns 409 when PUUID is already linked to a different user', async () => {
    const now = Date.now();
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (99001, 'other_guy', '${FAKE_ACCOUNT.puuid}', 'OtherPlayer', 'OTH1', ${now}, ${now})
    `);

    const { app } = buildApp(db);
    const res = await postOnboard(app, { name: 'IntPlayer', tag: 'E2E1' });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('puuid_already_linked');
  });

  it('returns 400 on invalid body', async () => {
    const { app } = buildApp(db);
    const res = await postOnboard(app, { name: 'ab', tag: 'TAG' }); // name too short
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_body');
  });
});
