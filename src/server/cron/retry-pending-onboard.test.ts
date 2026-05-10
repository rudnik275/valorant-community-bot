/**
 * retry-pending-onboard.test.ts — Unit tests for the daily pending-onboard retry cron.
 *
 * Uses better-sqlite3 (in-memory) + drizzle/better-sqlite3.
 * 4 cases per issue #127 spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import {
  runRetryPendingOnboardTick,
  type RetryPendingOnboardDeps,
} from './retry-pending-onboard.ts';
import {
  HenrikInactiveAccountError,
  HenrikNotFoundError,
  type RiotAccount,
} from '../lib/henrik.ts';
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

const MOCK_ACCOUNT: RiotAccount = {
  puuid: 'puuid-resolved-123',
  name: 'ActivePlayer',
  tag: 'EU1',
  region: 'eu',
  cardId: null,
};

function makeDeps(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: Partial<RetryPendingOnboardDeps> = {},
): RetryPendingOnboardDeps {
  return {
    db,
    validateAccount: vi.fn().mockResolvedValue(MOCK_ACCOUNT),
    scanForPuuid: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runRetryPendingOnboardTick', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  // Case 1: Pending user, Henrik now succeeds → puuid filled, scan triggered
  it('pending user → Henrik succeeds → riot_puuid filled, scanForPuuid called', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (1, 'alice', 'InactivePlayer', 'EU1', ${Date.now()})`,
    );

    const scanForPuuid = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { scanForPuuid });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_puuid, riot_name, riot_tag, riot_region FROM users WHERE telegram_id = 1')
      .get() as { riot_puuid: string | null; riot_name: string; riot_tag: string; riot_region: string | null };

    expect(row.riot_puuid).toBe(MOCK_ACCOUNT.puuid);
    expect(row.riot_name).toBe(MOCK_ACCOUNT.name);
    expect(row.riot_tag).toBe(MOCK_ACCOUNT.tag);
    expect(row.riot_region).toBe(MOCK_ACCOUNT.region);

    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(scanForPuuid).toHaveBeenCalledWith(MOCK_ACCOUNT.puuid, { detection: false });
  });

  // Case 2: Pending user, Henrik still code:24 → no DB change
  it('pending user → Henrik still code:24 → no DB change', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (2, 'bob', 'StillInactive', 'EU2', ${Date.now()})`,
    );

    const scanForPuuid = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikInactiveAccountError()),
      scanForPuuid,
    });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_puuid FROM users WHERE telegram_id = 2')
      .get() as { riot_puuid: string | null };

    expect(row.riot_puuid).toBeNull();
    expect(scanForPuuid).not.toHaveBeenCalled();
  });

  // Case 3: Pending user, Henrik 404 not-found → no DB change, log warn
  it('pending user → Henrik not-found → no DB change, warn logged', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (3, 'carol', 'GhostPlayer', 'XX1', ${Date.now()})`,
    );

    const scanForPuuid = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikNotFoundError()),
      scanForPuuid,
    });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_puuid FROM users WHERE telegram_id = 3')
      .get() as { riot_puuid: string | null };

    expect(row.riot_puuid).toBeNull();
    expect(scanForPuuid).not.toHaveBeenCalled();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'retry-pending-onboard', telegram_id: 3 }),
      expect.stringContaining('validateAccount failed'),
    );
  });

  // Case 4: Fully-linked user (puuid set) → not picked up
  it('linked user (riot_puuid set) → not picked up by cron', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (4, 'dave', 'puuid-already-linked', 'LinkedPlayer', 'EU1', ${Date.now()})`,
    );

    const validateAccount = vi.fn().mockResolvedValue(MOCK_ACCOUNT);
    const deps = makeDeps(db, { validateAccount });

    await runRetryPendingOnboardTick(deps);

    // validateAccount should not be called for already-linked user
    expect(validateAccount).not.toHaveBeenCalled();

    // puuid unchanged
    const row = sqlite
      .prepare('SELECT riot_puuid FROM users WHERE telegram_id = 4')
      .get() as { riot_puuid: string };
    expect(row.riot_puuid).toBe('puuid-already-linked');
  });
});
