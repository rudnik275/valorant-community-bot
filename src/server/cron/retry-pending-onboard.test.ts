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
  HenrikUpstreamError,
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

  // Case 3: Pending user, Henrik 404 not-found → CLEAR the nick (#350).
  //
  // Since onboard started admitting on Henrik-side failures, a pending row can
  // hold a nick nobody ever verified. A definitive 404 is the verdict that says
  // it is junk; clearing name+tag returns the row to «no nick», which is the
  // state restrict-grace already re-gates. Without this the user keeps group
  // access forever on a nick that does not exist.
  it('pending user → Henrik not-found → nick cleared so restrict-grace re-gates', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (3, 'carol', 'GhostPlayer', 'XX1', ${Date.now()})`,
    );

    const scanForPuuid = vi.fn().mockResolvedValue(undefined);
    const onNickCleared = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikNotFoundError()),
      scanForPuuid,
      onNickCleared,
    });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_name, riot_tag, riot_puuid FROM users WHERE telegram_id = 3')
      .get() as { riot_name: string | null; riot_tag: string | null; riot_puuid: string | null };

    expect(row.riot_name).toBeNull();
    expect(row.riot_tag).toBeNull();
    expect(row.riot_puuid).toBeNull();
    expect(scanForPuuid).not.toHaveBeenCalled();

    // The user must be told — an unexplained re-mute reads as the bot breaking.
    expect(onNickCleared).toHaveBeenCalledWith(3, 'GhostPlayer', 'XX1');
  });

  it('clearing survives a failing notification', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (7, 'grace', 'GhostPlayer', 'XX1', ${Date.now()})`,
    );

    const deps = makeDeps(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikNotFoundError()),
      scanForPuuid: vi.fn().mockResolvedValue(undefined),
      onNickCleared: vi.fn().mockRejectedValue(new Error('telegram down')),
    });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_name FROM users WHERE telegram_id = 7')
      .get() as { riot_name: string | null };
    expect(row.riot_name).toBeNull();
  });

  // The mirror of case 3: a Henrik-side failure is NOT a verdict, so the row
  // must survive untouched. Getting this wrong would wash out real members
  // during an outage — the exact failure the admit-on-trust rule guards against.
  it('pending user → Henrik-side failure → nick preserved, retried tomorrow', async () => {
    sqlite.exec(
      `INSERT INTO users (telegram_id, telegram_username, riot_name, riot_tag, joined_at)
       VALUES (8, 'heidi', 'RealPlayer', 'EU1', ${Date.now()})`,
    );

    const onNickCleared = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, {
      validateAccount: vi.fn().mockRejectedValue(new HenrikUpstreamError(503, 'down')),
      scanForPuuid: vi.fn().mockResolvedValue(undefined),
      onNickCleared,
    });

    await runRetryPendingOnboardTick(deps);

    const row = sqlite
      .prepare('SELECT riot_name, riot_tag FROM users WHERE telegram_id = 8')
      .get() as { riot_name: string | null; riot_tag: string | null };

    expect(row.riot_name).toBe('RealPlayer');
    expect(row.riot_tag).toBe('EU1');
    expect(onNickCleared).not.toHaveBeenCalled();
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
