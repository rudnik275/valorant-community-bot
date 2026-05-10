/**
 * restrict-grace.test.ts — Unit tests for the daily grace-period restrict cron.
 *
 * Uses better-sqlite3 (in-memory) + drizzle/better-sqlite3.
 * 8 cases per issue #118 spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { runRestrictGraceTick, READONLY_PERMISSIONS, type RestrictGraceDeps } from './restrict-grace.ts';
import { users } from '../db/schema/users.ts';
import logger from '../lib/log.ts';

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

const BOT_ID = 999;
const CHAT_ID = -100100;
const NOW_MS = 1_750_000_000_000; // arbitrary fixed time
const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** joined_at 31 days ago (past grace) */
const JOINED_31D_AGO = NOW_MS - GRACE_MS - 86_400_000;
/** joined_at 5 days ago (within grace) */
const JOINED_5D_AGO = NOW_MS - 5 * 86_400_000;

function makeDeps(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: Partial<RestrictGraceDeps> = {},
): RestrictGraceDeps {
  return {
    db,
    getAllowedChatIds: () => new Set([CHAT_ID]),
    getBotId: () => BOT_ID,
    restrictChatMember: vi.fn().mockResolvedValue(undefined),
    getChatAdministrators: vi.fn().mockResolvedValue([]),
    getNowMs: () => NOW_MS,
    ...overrides,
  };
}

describe('runRestrictGraceTick', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  // Case 0: Pending-onboard user (riot_name set, riot_puuid NULL) → not restricted
  it('pending-onboard user (riot_name set, riot_puuid NULL) → not restricted', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (10, 'pending', 'InactivePlayer', 'EU1', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 10').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();
  });

  // Case 1: Linked user (riot_name + riot_puuid both set) → not restricted
  it('linked user (riot_name + riot_puuid set) → not restricted', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, riot_puuid, joined_at)
       VALUES (1, 'alice', 'Alice', 'EU1', 'puuid-alice', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 1').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();
  });

  // Case 2: Unlinked, joined_at = now - 31d → restricted; restricted_at populated
  it('unlinked user joined 31d ago → restricted; restricted_at set', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (2, 'bob', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).toHaveBeenCalledOnce();
    expect(restrictChatMember).toHaveBeenCalledWith(CHAT_ID, 2, READONLY_PERMISSIONS);

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 2').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBe(NOW_MS);
  });

  // Case 3: Unlinked, joined_at = now - 5d → not restricted (within grace)
  it('unlinked user joined 5d ago → not restricted (within grace)', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (3, 'carol', ${JOINED_5D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 3').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();
  });

  // Case 4: Already-restricted (restricted_at NOT NULL) → no second API call
  it('already-restricted user → no second API call', async () => {
    const ALREADY_RESTRICTED_AT = NOW_MS - 86_400_000; // restricted yesterday
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at, restricted_at)
       VALUES (4, 'dave', ${JOINED_31D_AGO}, ${ALREADY_RESTRICTED_AT})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();
  });

  // Case 5: Admin user → not restricted (mock getChatAdministrators)
  it('admin user → not restricted', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (5, 'eve', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const getChatAdministrators = vi.fn().mockResolvedValue([{ user: { id: 5 } }]);
    const deps = makeDeps(db, { restrictChatMember, getChatAdministrators });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 5').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();
  });

  // Case 6: Bot user → not restricted
  it('bot user (telegram_id = botId) → not restricted', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (${BOT_ID}, 'mybot', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { restrictChatMember });

    await runRestrictGraceTick(deps);

    expect(restrictChatMember).not.toHaveBeenCalled();

    const row = sqlite.prepare(`SELECT restricted_at FROM users WHERE telegram_id = ${BOT_ID}`).get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();
  });

  // Case 7: Bot API failure on restrictChatMember → restricted_at NOT updated, no crash
  it('restrictChatMember fails → restricted_at NOT updated, no crash', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (7, 'frank', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockRejectedValue(new Error('not enough rights'));
    const deps = makeDeps(db, { restrictChatMember });

    // Should not throw
    await expect(runRestrictGraceTick(deps)).resolves.toBeUndefined();

    expect(restrictChatMember).toHaveBeenCalled();

    const row = sqlite.prepare('SELECT restricted_at FROM users WHERE telegram_id = 7').get() as { restricted_at: number | null };
    expect(row.restricted_at).toBeNull();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'restrict-grace', telegram_id: 7 }),
      expect.stringContaining('restrictChatMember failed'),
    );
  });

  // Case 8: Bot API failure on getChatAdministrators → whole chat skipped, log warning
  it('getChatAdministrators fails → whole chat skipped, warning logged, no crash', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, joined_at)
       VALUES (8, 'grace', ${JOINED_31D_AGO})`,
    );

    const restrictChatMember = vi.fn().mockResolvedValue(undefined);
    const getChatAdministrators = vi.fn().mockRejectedValue(new Error('Forbidden'));
    const deps = makeDeps(db, { restrictChatMember, getChatAdministrators });

    // Should not throw
    await expect(runRestrictGraceTick(deps)).resolves.toBeUndefined();

    // restrictChatMember must NOT be called — whole chat is skipped
    expect(restrictChatMember).not.toHaveBeenCalled();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'restrict-grace', chat_id: CHAT_ID }),
      expect.stringContaining('getChatAdministrators failed'),
    );
  });
});
