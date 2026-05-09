import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { makeRiotIdTracker } from './riot-id-tracker.ts';
import { users } from '../db/schema/users.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import logger from '../lib/log.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function seedUser(
  sqlite: InstanceType<typeof Database>,
  opts: {
    id: number;
    puuid?: string | null;
    name?: string;
    tag?: string;
    failedSince?: number | null;
  },
) {
  const { id, puuid = null, name = 'Player', tag = 'TAG', failedSince = null } = opts;
  if (puuid) {
    sqlite.exec(
      `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, riot_lookup_failed_since, joined_at)
       VALUES (${id}, '${puuid}', '${name}', '${tag}', ${failedSince ?? 'NULL'}, ${Date.now()})`,
    );
  } else {
    sqlite.exec(
      `INSERT INTO users (telegram_id, joined_at) VALUES (${id}, ${Date.now()})`,
    );
  }
}

const noSleep = () => Promise.resolve();

describe('makeRiotIdTracker', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: InstanceType<typeof Database>;
  let getAccountByPuuid: ReturnType<typeof vi.fn>;
  let setCustomTitleInChat: ReturnType<typeof vi.fn>;
  let getAllowedChatIds: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    getAccountByPuuid = vi.fn();
    setCustomTitleInChat = vi.fn().mockResolvedValue(undefined);
    getAllowedChatIds = vi.fn().mockReturnValue(new Set([-100111, -100222]));
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  function makeTracker() {
    return makeRiotIdTracker({
      db,
      getAccountByPuuid,
      setCustomTitleInChat,
      getAllowedChatIds,
      sleep: noSleep,
    });
  }

  // ─── Name changed → UPDATE + setCustomTitleInChat per chat ─────────────────

  it('name changed → updates DB and calls setCustomTitleInChat for each allowed chat', async () => {
    seedUser(sqlite, { id: 1, puuid: 'puuid-1', name: 'OldName', tag: 'NA1' });
    getAccountByPuuid.mockResolvedValue({ puuid: 'puuid-1', name: 'NewName', tag: 'NA1', region: 'na' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    // DB updated
    const [row] = await db.select({ riot_name: users.riot_name, riot_tag: users.riot_tag, riot_lookup_failed_since: users.riot_lookup_failed_since })
      .from(users)
      .where(eq(users.telegram_id, 1));
    expect(row?.riot_name).toBe('NewName');
    expect(row?.riot_tag).toBe('NA1');
    expect(row?.riot_lookup_failed_since).toBeNull();

    // setCustomTitleInChat called for each allowed chat
    expect(setCustomTitleInChat).toHaveBeenCalledTimes(2);
    expect(setCustomTitleInChat).toHaveBeenCalledWith(-100111, 1, 'NewName#NA1');
    expect(setCustomTitleInChat).toHaveBeenCalledWith(-100222, 1, 'NewName#NA1');
  });

  // ─── Name unchanged → no UPDATE, no Telegram call ──────────────────────────

  it('name unchanged → no DB update, no Telegram call', async () => {
    seedUser(sqlite, { id: 2, puuid: 'puuid-2', name: 'SameName', tag: 'EU1' });
    getAccountByPuuid.mockResolvedValue({ puuid: 'puuid-2', name: 'SameName', tag: 'EU1', region: 'eu' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    expect(setCustomTitleInChat).not.toHaveBeenCalled();
  });

  // ─── 404 first time → riot_lookup_failed_since set ─────────────────────────

  it('404 first time → sets riot_lookup_failed_since to a timestamp close to now', async () => {
    seedUser(sqlite, { id: 3, puuid: 'puuid-3', name: 'Player', tag: 'TAG' });

    const { HenrikNotFoundError } = await import('../lib/henrik.ts');
    getAccountByPuuid.mockRejectedValue(new HenrikNotFoundError());

    const before = Date.now();
    const tracker = makeTracker();
    await tracker.refreshAll();
    const after = Date.now();

    const [row] = await db.select({ riot_lookup_failed_since: users.riot_lookup_failed_since })
      .from(users)
      .where(eq(users.telegram_id, 3));

    expect(row?.riot_lookup_failed_since).not.toBeNull();
    expect(row?.riot_lookup_failed_since).toBeGreaterThanOrEqual(before);
    expect(row?.riot_lookup_failed_since).toBeLessThanOrEqual(after);

    // No Telegram update
    expect(setCustomTitleInChat).not.toHaveBeenCalled();
  });

  // ─── 404 second time → riot_lookup_failed_since preserved ──────────────────

  it('404 second time → riot_lookup_failed_since NOT overwritten (preserves first value)', async () => {
    const originalFailedSince = 1700000000000;
    seedUser(sqlite, { id: 4, puuid: 'puuid-4', name: 'Player', tag: 'TAG', failedSince: originalFailedSince });

    const { HenrikNotFoundError } = await import('../lib/henrik.ts');
    getAccountByPuuid.mockRejectedValue(new HenrikNotFoundError());

    const tracker = makeTracker();
    await tracker.refreshAll();

    const [row] = await db.select({ riot_lookup_failed_since: users.riot_lookup_failed_since })
      .from(users)
      .where(eq(users.telegram_id, 4));

    // Should still be the original value — not updated
    expect(row?.riot_lookup_failed_since).toBe(originalFailedSince);
  });

  // ─── Recovery → riot_lookup_failed_since cleared ───────────────────────────

  it('successful lookup after past failure → clears riot_lookup_failed_since', async () => {
    const originalFailedSince = 1700000000000;
    seedUser(sqlite, { id: 5, puuid: 'puuid-5', name: 'Player', tag: 'TAG', failedSince: originalFailedSince });

    // Account still has the same name — unchanged lookup
    getAccountByPuuid.mockResolvedValue({ puuid: 'puuid-5', name: 'Player', tag: 'TAG', region: 'eu' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    const [row] = await db.select({ riot_lookup_failed_since: users.riot_lookup_failed_since })
      .from(users)
      .where(eq(users.telegram_id, 5));

    // Failed_since should be cleared on recovery
    expect(row?.riot_lookup_failed_since).toBeNull();
  });

  it('successful lookup with name change after past failure → clears riot_lookup_failed_since', async () => {
    const originalFailedSince = 1700000000000;
    seedUser(sqlite, { id: 6, puuid: 'puuid-6', name: 'OldName', tag: 'EU1', failedSince: originalFailedSince });

    getAccountByPuuid.mockResolvedValue({ puuid: 'puuid-6', name: 'NewName', tag: 'EU1', region: 'eu' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    const [row] = await db.select({ riot_name: users.riot_name, riot_lookup_failed_since: users.riot_lookup_failed_since })
      .from(users)
      .where(eq(users.telegram_id, 6));

    expect(row?.riot_name).toBe('NewName');
    expect(row?.riot_lookup_failed_since).toBeNull();
  });

  // ─── "bot is not admin" error → log warn, no crash ─────────────────────────

  it('"bot is not admin" error → logs warn and continues without crashing', async () => {
    seedUser(sqlite, { id: 7, puuid: 'puuid-7', name: 'OldName', tag: 'EU1' });
    seedUser(sqlite, { id: 8, puuid: 'puuid-8', name: 'OldName2', tag: 'EU2' });

    getAccountByPuuid.mockResolvedValue({ puuid: 'doesnt-matter', name: 'NewName', tag: 'EU1', region: 'eu' });

    setCustomTitleInChat.mockRejectedValue(new Error('Bad Request: not enough rights to change title of the other users'));

    const tracker = makeTracker();
    await tracker.refreshAll();

    // Should have logged warn
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'not_admin' }),
      expect.any(String),
    );

    // Should not have crashed — second user also processed
    expect(getAccountByPuuid).toHaveBeenCalledTimes(2);
  });

  // ─── User with null riot_puuid → not selected ──────────────────────────────

  it('user with riot_puuid IS NULL is not selected and not processed', async () => {
    seedUser(sqlite, { id: 9, puuid: null }); // no puuid
    seedUser(sqlite, { id: 10, puuid: 'puuid-10', name: 'Player10', tag: 'TAG' });

    getAccountByPuuid.mockResolvedValue({ puuid: 'puuid-10', name: 'Player10', tag: 'TAG', region: 'eu' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    // Only the user with a puuid should be processed
    expect(getAccountByPuuid).toHaveBeenCalledTimes(1);
    expect(getAccountByPuuid).toHaveBeenCalledWith('puuid-10');
  });

  // ─── HenrikRateLimitError → log warn, no update ────────────────────────────

  it('HenrikRateLimitError → logs warn, no DB update, continues to next user', async () => {
    seedUser(sqlite, { id: 11, puuid: 'puuid-11', name: 'Player11', tag: 'EU1' });
    seedUser(sqlite, { id: 12, puuid: 'puuid-12', name: 'Player12', tag: 'EU2' });

    const { HenrikRateLimitError } = await import('../lib/henrik.ts');
    getAccountByPuuid
      .mockRejectedValueOnce(new HenrikRateLimitError(60))
      .mockResolvedValueOnce({ puuid: 'puuid-12', name: 'Player12', tag: 'EU2', region: 'eu' });

    const tracker = makeTracker();
    await tracker.refreshAll();

    // Warn should be logged for rate limit
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ retryAfter: 60 }),
      expect.any(String),
    );

    // Second user should still be processed
    expect(getAccountByPuuid).toHaveBeenCalledTimes(2);
  });
});
