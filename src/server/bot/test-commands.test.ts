import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import {
  isOwner,
  OWNER_TELEGRAM_ID,
  parseDaysArg,
  parseDaysBackArg,
  makeTestDigestHandler,
  makeTestRuntimeEventsHandler,
  makeTestDailyCronHandler,
  resolveDailyCronWindow,
} from './test-commands.ts';

describe('isOwner', () => {
  it('returns true for the hardcoded OWNER_TELEGRAM_ID', () => {
    expect(isOwner(OWNER_TELEGRAM_ID)).toBe(true);
  });

  it('returns false for any other telegram_id', () => {
    expect(isOwner(99999)).toBe(false);
    expect(isOwner(OWNER_TELEGRAM_ID + 1)).toBe(false);
  });

  it('returns false when telegram_id is undefined', () => {
    expect(isOwner(undefined)).toBe(false);
  });
});

describe('parseDaysArg', () => {
  it('returns fallback when text is undefined', () => {
    expect(parseDaysArg(undefined, 7)).toBe(7);
  });

  it('returns fallback when text has no argument', () => {
    expect(parseDaysArg('/test_digest', 7)).toBe(7);
    expect(parseDaysArg('/test_digest   ', 7)).toBe(7);
  });

  it('parses a positive integer argument', () => {
    expect(parseDaysArg('/test_digest 3', 7)).toBe(3);
    expect(parseDaysArg('/test_digest 14', 7)).toBe(14);
  });

  it('strips @botname suffix', () => {
    expect(parseDaysArg('/test_digest@MyBot 5', 7)).toBe(5);
  });

  it('clamps below MIN_DAYS=1 to MIN_DAYS', () => {
    expect(parseDaysArg('/test_digest 0', 7)).toBe(1);
    expect(parseDaysArg('/test_digest -3', 7)).toBe(1);
  });

  it('clamps above MAX_DAYS=30 to MAX_DAYS', () => {
    expect(parseDaysArg('/test_digest 100', 7)).toBe(30);
  });

  it('returns fallback for non-integer values', () => {
    expect(parseDaysArg('/test_digest 7.5', 7)).toBe(7);
    expect(parseDaysArg('/test_digest abc', 7)).toBe(7);
  });

  it('takes only the first positional token', () => {
    expect(parseDaysArg('/test_digest 5 extra ignored', 7)).toBe(5);
  });
});

describe('admin gate (non-owner is silently ignored)', () => {
  function makeMockBot() {
    return {
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    };
  }
  function makeMockDb() {
    return {
      select: vi.fn(),
    };
  }

  it('test_digest handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_digest 3' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_runtime_events handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestRuntimeEventsHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_runtime_events 2' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_digest handler: missing ctx.from is treated as non-owner', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { message: { text: '/test_digest' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── parseDaysBackArg ────────────────────────────────────────────────────────

describe('parseDaysBackArg', () => {
  it('returns 0 when text is undefined', () => {
    expect(parseDaysBackArg(undefined)).toBe(0);
  });

  it('returns 0 when arg is missing (just the slash command)', () => {
    expect(parseDaysBackArg('/test_daily_cron')).toBe(0);
    expect(parseDaysBackArg('/test_daily_cron   ')).toBe(0);
  });

  it('returns 0 for non-numeric arg', () => {
    expect(parseDaysBackArg('/test_daily_cron abc')).toBe(0);
  });

  it('returns 0 for negative numbers (clamps to 0)', () => {
    expect(parseDaysBackArg('/test_daily_cron -3')).toBe(0);
  });

  it('returns N for valid 0..30', () => {
    expect(parseDaysBackArg('/test_daily_cron 0')).toBe(0);
    expect(parseDaysBackArg('/test_daily_cron 1')).toBe(1);
    expect(parseDaysBackArg('/test_daily_cron 30')).toBe(30);
  });

  it('clamps values above 30 to 30', () => {
    expect(parseDaysBackArg('/test_daily_cron 100')).toBe(30);
  });

  it('handles bot-name suffix in slash command', () => {
    expect(parseDaysBackArg('/test_daily_cron@mybot 5')).toBe(5);
  });
});

// ─── /test_daily_cron ────────────────────────────────────────────────────────

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function seedUser(sqlite: Database.Database, id: number, puuid: string) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, puuid, `Player${id}`, 'TAG', Date.now());
}

function seedMatch(sqlite: Database.Database, puuid: string, matchId: string, startedAt: number) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO match_records
       (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
       VALUES (?, ?, ?, 'Ascent', 'Jett', 15, 10, 0, 'win', 20, '[]')`,
    )
    .run(puuid, matchId, startedAt);
}

function seedAceEvent(
  sqlite: Database.Database,
  puuid: string,
  matchId: string,
  detectedAt: number,
  status = 'silent',
): number {
  const payload = { weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']] };
  const result = sqlite
    .prepare(
      `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
       VALUES ('ace', ?, ?, ?, ?, ?)`,
    )
    .run(puuid, matchId, JSON.stringify(payload), detectedAt, status);
  return result.lastInsertRowid as number;
}

function seedDailyRun(sqlite: Database.Database, runDate: string, postedAt: number | null) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO daily_digest_runs
       (run_date, started_at, posted_at, included_event_ids)
       VALUES (?, ?, ?, '[]')`,
    )
    .run(runDate, postedAt ?? Date.now() - 60_000, postedAt);
}

describe('resolveDailyCronWindow (daysBack=0)', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('falls back to 24h when no daily_digest_runs rows exist', async () => {
    const before = Date.now();
    const { windowStart, windowEnd } = await resolveDailyCronWindow(db, 0);
    const after = Date.now();

    expect(windowEnd).toBeGreaterThanOrEqual(before);
    expect(windowEnd).toBeLessThanOrEqual(after);
    expect(windowStart).toBeCloseTo(windowEnd - 24 * 3600 * 1000, -2);
  });

  it('falls back to 24h when runs exist but all have posted_at=null', async () => {
    seedDailyRun(sqlite, '2025-01-01', null);
    const before = Date.now();
    const { windowStart, windowEnd } = await resolveDailyCronWindow(db, 0);
    const after = Date.now();

    expect(windowEnd).toBeGreaterThanOrEqual(before);
    expect(windowEnd).toBeLessThanOrEqual(after);
    expect(windowStart).toBeCloseTo(windowEnd - 24 * 3600 * 1000, -2);
  });

  it('uses the most recent posted_at as windowStart', async () => {
    const olderPostedAt = Date.now() - 48 * 3600 * 1000;
    const recentPostedAt = Date.now() - 3 * 3600 * 1000;
    seedDailyRun(sqlite, '2025-01-01', olderPostedAt);
    seedDailyRun(sqlite, '2025-01-02', recentPostedAt);

    const { windowStart } = await resolveDailyCronWindow(db, 0);
    expect(windowStart).toBe(recentPostedAt);
  });
});

describe('resolveDailyCronWindow (daysBack >= 1)', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  // Pick a fixed nowMs well inside DST (Aug 1 2026 12:00 UTC) so we deterministically
  // hit the +3 Kyiv offset and avoid DST-transition edge cases in test assertions.
  const NOW_DST = Date.UTC(2026, 7, 1, 12, 0, 0);

  function kyivDateOf(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ms);
  }

  function kyivHourOf(ms: number): number {
    return Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false,
    }).formatToParts(ms).find((p) => p.type === 'hour')?.value ?? -1);
  }

  it('daysBack=1 → windowEnd is 23:00 Kyiv yesterday, windowStart is 23:00 Kyiv day before', async () => {
    const { windowStart, windowEnd } = await resolveDailyCronWindow(db, 1, NOW_DST);
    expect(kyivHourOf(windowStart)).toBe(23);
    expect(kyivHourOf(windowEnd)).toBe(23);
    expect(windowEnd - windowStart).toBe(24 * 3600 * 1000);
    // windowEnd date = yesterday Kyiv relative to NOW_DST.
    expect(kyivDateOf(windowEnd)).toBe('2026-07-31');
    expect(kyivDateOf(windowStart)).toBe('2026-07-30');
  });

  it('daysBack=2 → window is 2 days before NOW_DST', async () => {
    const { windowStart, windowEnd } = await resolveDailyCronWindow(db, 2, NOW_DST);
    expect(kyivDateOf(windowEnd)).toBe('2026-07-30');
    expect(kyivDateOf(windowStart)).toBe('2026-07-29');
  });

  it('does NOT consult daily_digest_runs for daysBack >= 1', async () => {
    // Seed a recent posted_at — should be ignored when daysBack=1.
    seedDailyRun(sqlite, '2026-07-31', Date.now() - 1000);
    const { windowEnd } = await resolveDailyCronWindow(db, 1, NOW_DST);
    expect(kyivDateOf(windowEnd)).toBe('2026-07-31');
    expect(kyivHourOf(windowEnd)).toBe(23);
  });
});

describe('makeTestDailyCronHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeMockBot() {
    return {
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    };
  }

  it('non-owner is silently ignored — no sendMessage', async () => {
    const bot = makeMockBot();
    const handler = makeTestDailyCronHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_daily_cron' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('owner + empty daily_digest_runs + no aces → fallback 24h window + "Нет ейсов" reply', async () => {
    const bot = makeMockBot();
    const handler = makeTestDailyCronHandler({ db, bot: bot as never });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/test_daily_cron' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [targetId, text] = bot.api.sendMessage.mock.calls[0]!;
    expect(targetId).toBe(OWNER_TELEGRAM_ID);
    expect(text).toContain('Нет ейсов с прошлого тика');
    // Should include ISO window bounds
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('owner + recent successful run → windowStart = last posted_at', async () => {
    const postedAt = Date.now() - 5 * 3600 * 1000; // 5h ago
    seedDailyRun(sqlite, '2025-05-10', postedAt);

    const bot = makeMockBot();
    const handler = makeTestDailyCronHandler({ db, bot: bot as never });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/test_daily_cron' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    // No aces in DB → null text → sends "Нет ейсов" with correct window start ISO
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = bot.api.sendMessage.mock.calls[0]!;
    expect(text).toContain('Нет ейсов с прошлого тика');
    // The window start should appear in the message as ISO string of postedAt
    const expectedIso = new Date(postedAt).toISOString();
    expect(text).toContain(expectedIso);
  });

  it('owner + aces in window → text reply contains rendered output', async () => {
    const postedAt = Date.now() - 6 * 3600 * 1000;
    seedDailyRun(sqlite, '2025-05-10', postedAt);

    const inWindow = postedAt + 1000; // after last run
    seedUser(sqlite, 1, 'p1');
    seedMatch(sqlite, 'p1', 'match-1', inWindow);
    seedAceEvent(sqlite, 'p1', 'match-1', inWindow);

    const bot = makeMockBot();
    const handler = makeTestDailyCronHandler({ db, bot: bot as never });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/test_daily_cron' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [targetId, text] = bot.api.sendMessage.mock.calls[0]!;
    expect(targetId).toBe(OWNER_TELEGRAM_ID);
    // Rendered digest header
    expect(text).toContain('Daily Ace');
    expect(text).toContain('Player1');
  });

  it('does NOT insert into daily_digest_runs', async () => {
    seedUser(sqlite, 1, 'p1');
    const inWindow = Date.now() - 1000;
    seedMatch(sqlite, 'p1', 'match-1', inWindow);
    seedAceEvent(sqlite, 'p1', 'match-1', inWindow);

    const bot = makeMockBot();
    const handler = makeTestDailyCronHandler({ db, bot: bot as never });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/test_daily_cron' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    const rows = sqlite.prepare('SELECT COUNT(*) AS cnt FROM daily_digest_runs').get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});
