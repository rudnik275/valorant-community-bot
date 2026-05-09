/**
 * telegram-avatar.test.ts — Unit tests for the lazy avatar cache.
 *
 * Uses better-sqlite3 (in-memory) + drizzle/better-sqlite3 so Vitest (Node)
 * can run without bun:sqlite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { makeAvatarCache, UserNotFoundError } from './telegram-avatar.ts';
import { users } from '../db/schema/users.ts';

vi.mock('./log.ts', () => ({
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

const BOT_TOKEN = 'test-bot-token';

describe('makeAvatarCache', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    // Insert a test user without avatar info
    db.insert(users).values({ telegram_id: 42, telegram_username: 'alice' }).run();
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  it('throws UserNotFoundError if user row does not exist', async () => {
    const getApi = vi.fn();
    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });

    await expect(cache.ensureAvatar(9999)).rejects.toThrow(UserNotFoundError);
  });

  it('first call — hits getUserProfilePhotos and getFile, persists URL, returns it', async () => {
    const getUserProfilePhotos = vi.fn().mockResolvedValue({
      total_count: 1,
      photos: [[{ file_id: 'file-abc', width: 160, height: 160 }]],
    });
    const getFile = vi.fn().mockResolvedValue({ file_path: 'photos/user42.jpg' });
    const getApi = vi.fn().mockReturnValue({ getUserProfilePhotos, getFile });

    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });
    const result = await cache.ensureAvatar(42);

    expect(getUserProfilePhotos).toHaveBeenCalledOnce();
    expect(getFile).toHaveBeenCalledOnce();
    expect(result.fileId).toBe('file-abc');
    expect(result.url).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/photos/user42.jpg`);

    // Verify persisted in DB
    const rows = db.select().from(users).all();
    expect(rows[0]?.telegram_avatar_url).toBe(result.url);
    expect(rows[0]?.telegram_avatar_file_id).toBe('file-abc');
    expect(rows[0]?.telegram_avatar_fetched_at).toBeGreaterThan(0);
  });

  it('second call within 24h — returns cached value, no API calls', async () => {
    const getUserProfilePhotos = vi.fn().mockResolvedValue({
      total_count: 1,
      photos: [[{ file_id: 'file-abc', width: 160, height: 160 }]],
    });
    const getFile = vi.fn().mockResolvedValue({ file_path: 'photos/user42.jpg' });
    const getApi = vi.fn().mockReturnValue({ getUserProfilePhotos, getFile });

    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });

    // First call to populate cache
    await cache.ensureAvatar(42);
    expect(getUserProfilePhotos).toHaveBeenCalledOnce();

    // Reset mocks to verify second call uses cache
    getUserProfilePhotos.mockClear();
    getFile.mockClear();

    // Second call — should use cached result
    const result = await cache.ensureAvatar(42);

    expect(getUserProfilePhotos).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
    expect(result.fileId).toBe('file-abc');
    expect(result.url).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/photos/user42.jpg`);
  });

  it('total_count === 0 — sets nulls + fetched_at, no getFile call, returns {url: null, fileId: null}', async () => {
    const getUserProfilePhotos = vi.fn().mockResolvedValue({
      total_count: 0,
      photos: [],
    });
    const getFile = vi.fn();
    const getApi = vi.fn().mockReturnValue({ getUserProfilePhotos, getFile });

    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });
    const result = await cache.ensureAvatar(42);

    expect(getUserProfilePhotos).toHaveBeenCalledOnce();
    expect(getFile).not.toHaveBeenCalled();
    expect(result).toEqual({ url: null, fileId: null });

    // fetched_at must be set so we don't re-fetch constantly
    const rows = db.select().from(users).all();
    expect(rows[0]?.telegram_avatar_url).toBeNull();
    expect(rows[0]?.telegram_avatar_file_id).toBeNull();
    expect(rows[0]?.telegram_avatar_fetched_at).toBeGreaterThan(0);
  });

  it('no-photo result is cached for 24h — second call within TTL uses cache (null returned without API call)', async () => {
    const getUserProfilePhotos = vi.fn().mockResolvedValue({
      total_count: 0,
      photos: [],
    });
    const getFile = vi.fn();
    const getApi = vi.fn().mockReturnValue({ getUserProfilePhotos, getFile });

    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });

    // First call
    await cache.ensureAvatar(42);
    expect(getUserProfilePhotos).toHaveBeenCalledOnce();

    getUserProfilePhotos.mockClear();

    // Second call within TTL — must NOT hit the API
    const result = await cache.ensureAvatar(42);
    expect(getUserProfilePhotos).not.toHaveBeenCalled();
    expect(result).toEqual({ url: null, fileId: null });
  });

  it('after 24h+1ms the cache expires and API is called again', async () => {
    const now = Date.now();
    // Manually set a stale fetched_at (25 hours ago) and avatar data
    const staleTs = now - (25 * 60 * 60 * 1000);
    const { eq } = await import('drizzle-orm');
    db.update(users)
      .set({
        telegram_avatar_url: 'https://old-url',
        telegram_avatar_file_id: 'old-file-id',
        telegram_avatar_fetched_at: staleTs,
      })
      .where(eq(users.telegram_id, 42))
      .run();

    const getUserProfilePhotos = vi.fn().mockResolvedValue({
      total_count: 1,
      photos: [[{ file_id: 'new-file-id', width: 160, height: 160 }]],
    });
    const getFile = vi.fn().mockResolvedValue({ file_path: 'photos/new.jpg' });
    const getApi = vi.fn().mockReturnValue({ getUserProfilePhotos, getFile });

    const cache = makeAvatarCache({ db, getApi, getBotToken: () => BOT_TOKEN });
    const result = await cache.ensureAvatar(42);

    // Should have hit the API
    expect(getUserProfilePhotos).toHaveBeenCalledOnce();
    expect(result.fileId).toBe('new-file-id');
    expect(result.url).toBe(`https://api.telegram.org/file/bot${BOT_TOKEN}/photos/new.jpg`);
  });
});
