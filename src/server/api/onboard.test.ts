import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { makeOnboardHandler } from './onboard.ts';
import type { TelegramUser } from '../lib/init-data.ts';
import {
  HenrikNotFoundError,
  HenrikRateLimitError,
  HenrikUpstreamError,
} from '../lib/henrik.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock scope.ts so safePromote/safeSetCustomTitle don't throw UnauthorizedChatError
vi.mock('../lib/scope.ts', () => ({
  isAllowedChat: vi.fn().mockReturnValue(true),
  loadAllowedChatIds: vi.fn().mockReturnValue(new Set([-100123])),
  _resetCache: vi.fn(),
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

interface OnboardSuccess {
  success: true;
  profile: { name: string; tag: string; puuid: string };
  joinedGroup: boolean;
}
interface OnboardError {
  error: string;
  retryAfter?: number;
  other?: string;
  chatId?: number;
}

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const MOCK_USER: TelegramUser = { id: 12345, first_name: 'Test', username: 'testuser' };
const MOCK_PUUID = 'puuid-abc-123-def';

const MOCK_ACCOUNT = {
  puuid: MOCK_PUUID,
  name: 'TestPlayer',
  tag: 'EU1',
  region: 'EU',
};

function makeBotApi() {
  return {
    promoteChatMember: vi.fn().mockResolvedValue(true),
    setChatAdministratorCustomTitle: vi.fn().mockResolvedValue(true),
  };
}

function makeApp(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: {
    validateAccount?: ReturnType<typeof vi.fn>;
    botApi?: ReturnType<typeof makeBotApi>;
    scanForPuuid?: ReturnType<typeof vi.fn>;
    telegramUser?: TelegramUser;
    getAllowedChatIds?: () => Set<number>;
  } = {},
) {
  const {
    validateAccount = vi.fn().mockResolvedValue(MOCK_ACCOUNT),
    botApi = makeBotApi(),
    scanForPuuid = undefined,
    telegramUser = MOCK_USER,
    getAllowedChatIds = () => new Set([-100123]),
  } = overrides;

  const app = new Hono();
  // Inject telegramUser (simulates auth middleware)
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
      getAllowedChatIds,
    }),
  );
  return { app, validateAccount, botApi };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('makeOnboardHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns 200 with success, profile, and joinedGroup on valid onboarding', async () => {
    const { app, botApi } = makeApp(db);
    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));

    expect(res.status).toBe(200);
    const body = await res.json() as OnboardSuccess;
    expect(body.success).toBe(true);
    expect(body.profile).toEqual({ name: 'TestPlayer', tag: 'EU1', puuid: MOCK_PUUID });
    expect(body.joinedGroup).toBe(true);
    // Promotion and custom title should have been applied
    expect(botApi.promoteChatMember).toHaveBeenCalledWith(-100123, 12345, { can_manage_chat: true });
    expect(botApi.setChatAdministratorCustomTitle).toHaveBeenCalledWith(-100123, 12345, 'TestPlayer#EU1');
  });

  it('UPSERTs user row with riot data and onboarded_at', async () => {
    const now = Date.now();
    // Pre-insert a user row (as if listener created it)
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, last_message_at, joined_at)
      VALUES (12345, 'testuser', ${now}, ${now})
    `);

    const { app } = makeApp(db);
    await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));

    const row = sqlite.prepare('SELECT riot_puuid, riot_name, riot_tag, onboarded_at FROM users WHERE telegram_id = 12345').get() as {
      riot_puuid: string;
      riot_name: string;
      riot_tag: string;
      onboarded_at: number;
    };
    expect(row.riot_puuid).toBe(MOCK_PUUID);
    expect(row.riot_name).toBe('TestPlayer');
    expect(row.riot_tag).toBe('EU1');
    expect(row.onboarded_at).toBeGreaterThan(0);
  });

  it('calls safePromote and safeSetCustomTitle for each allowed chat', async () => {
    const getAllowedChatIds = () => new Set([-100123, -100456]);
    const botApi = makeBotApi();
    const { app } = makeApp(db, { botApi, getAllowedChatIds });

    await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));

    expect(botApi.promoteChatMember).toHaveBeenCalledTimes(2);
    expect(botApi.setChatAdministratorCustomTitle).toHaveBeenCalledTimes(2);
    expect(botApi.promoteChatMember).toHaveBeenCalledWith(-100123, 12345, { can_manage_chat: true });
    expect(botApi.promoteChatMember).toHaveBeenCalledWith(-100456, 12345, { can_manage_chat: true });
  });

  it('calls scanForPuuid with {detection: false} when provided', async () => {
    const scanForPuuid = vi.fn().mockResolvedValue(undefined);
    const { app } = makeApp(db, { scanForPuuid });

    await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));

    // Give fire-and-forget time to run
    await new Promise((r) => setTimeout(r, 0));
    expect(scanForPuuid).toHaveBeenCalledWith(MOCK_PUUID, { detection: false });
  });

  // ── Error: Riot ID not found ────────────────────────────────────────────────

  it('returns 404 {error: riot_id_not_found} when Henrik returns 404', async () => {
    const validateAccount = vi.fn().mockRejectedValue(new HenrikNotFoundError());
    const { app } = makeApp(db, { validateAccount });

    const res = await app.request(makeRequest({ name: 'bad', tag: 'TAG' }));
    expect(res.status).toBe(404);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('riot_id_not_found');
  });

  // ── Error: Rate limit ───────────────────────────────────────────────────────

  it('returns 503 with retryAfter when Henrik is rate-limited', async () => {
    const validateAccount = vi.fn().mockRejectedValue(new HenrikRateLimitError(30));
    const { app } = makeApp(db, { validateAccount });

    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));
    expect(res.status).toBe(503);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('henrik_rate_limited');
    expect(body.retryAfter).toBe(30);
  });

  // ── Error: Henrik upstream error ────────────────────────────────────────────

  it('returns 502 when Henrik returns upstream error', async () => {
    const validateAccount = vi.fn().mockRejectedValue(new HenrikUpstreamError(500, 'Internal error'));
    const { app } = makeApp(db, { validateAccount });

    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));
    expect(res.status).toBe(502);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('henrik_unavailable');
  });

  // ── Error: Duplicate PUUID ──────────────────────────────────────────────────

  it('returns 409 with other username when PUUID is already linked to different user', async () => {
    const now = Date.now();
    // Insert another user that already has this PUUID
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (99999, 'otheruser', '${MOCK_PUUID}', 'OtherPlayer', 'EU1', ${now}, ${now})
    `);

    const { app } = makeApp(db);
    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));
    expect(res.status).toBe(409);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('puuid_already_linked');
    expect(body.other).toBe('@otheruser');
  });

  it('allows re-onboarding if PUUID matches current user', async () => {
    const now = Date.now();
    // Same user already has this PUUID
    sqlite.exec(`
      INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, onboarded_at, joined_at)
      VALUES (12345, 'testuser', '${MOCK_PUUID}', 'TestPlayer', 'EU1', ${now}, ${now})
    `);

    const { app } = makeApp(db);
    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));
    expect(res.status).toBe(200);
    const body = await res.json() as OnboardSuccess;
    expect(body.success).toBe(true);
  });

  // ── User not in group ───────────────────────────────────────────────────────

  it('returns 200 with joinedGroup:false when user is not in group', async () => {
    const botApi = {
      promoteChatMember: vi.fn().mockRejectedValue(new Error('Bad Request: user_not_found')),
      setChatAdministratorCustomTitle: vi.fn().mockResolvedValue(true),
    };
    const { app } = makeApp(db, { botApi });

    const res = await app.request(makeRequest({ name: 'TestPlayer', tag: 'EU1' }));
    expect(res.status).toBe(200);
    const body = await res.json() as OnboardSuccess;
    expect(body.success).toBe(true);
    expect(body.joinedGroup).toBe(false);
    // custom_title should NOT be called since user is not in group
    expect(botApi.setChatAdministratorCustomTitle).not.toHaveBeenCalled();
  });

  // ── Validation errors ───────────────────────────────────────────────────────

  it('returns 400 on invalid body (name too short)', async () => {
    const { app } = makeApp(db);
    const res = await app.request(makeRequest({ name: 'ab', tag: 'TAG' }));
    expect(res.status).toBe(400);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('invalid_body');
  });

  it('returns 400 on invalid body (tag too long)', async () => {
    const { app } = makeApp(db);
    const res = await app.request(makeRequest({ name: 'ValidName', tag: 'TOOLONG' }));
    expect(res.status).toBe(400);
    const body = await res.json() as OnboardError;
    expect(body.error).toBe('invalid_body');
  });
});
