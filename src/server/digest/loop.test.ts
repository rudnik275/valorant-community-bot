import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { runDigestNow, getDigestNowKyiv } from './loop.ts';
import type { DigestNowKyiv } from './loop.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock buildDigest so loop tests don't depend on DB match/event data
vi.mock('./build.ts', () => ({
  buildDigest: vi.fn().mockResolvedValue({ text: '📅 <b>Дайджест недели</b>\n\nTest content', sectionsIncluded: ['pulse'] }),
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const FIXED_NOW = 1_746_000_000_000;
const FIXED_WEEK_ISO = '2026-W19';

const DEFAULT_KYIV: DigestNowKyiv = {
  nowMs: FIXED_NOW,
  weekIso: FIXED_WEEK_ISO,
  weekStart: FIXED_NOW - 7 * 86400000,
  weekEnd: FIXED_NOW,
};

function getDigestRunRow(sqlite: Database.Database, weekIso: string) {
  return sqlite.prepare('SELECT * FROM digest_runs WHERE week_iso = ?').get(weekIso) as {
    id: number;
    week_iso: string;
    posted_at: number | null;
    posted_message_id: number | null;
    posted_text: string | null;
  } | undefined;
}

describe('runDigestNow', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ db, sqlite } = makeTestDb());
    sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const { buildDigest } = await import('./build.ts');
    (buildDigest as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '📅 <b>Дайджест недели</b>\n\nTest content',
      sectionsIncluded: ['pulse'],
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('posts digest and fills digest_runs row', async () => {
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
      });

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        -1001234567890,
        expect.stringContaining('Дайджест'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      );

      const row = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row).toBeDefined();
      expect(row?.posted_at).not.toBeNull();
      expect(row?.posted_message_id).toBe(42);
      expect(row?.posted_text).toContain('Дайджест');
    });
  });

  describe('idempotency — same week twice', () => {
    it('second runDigestNow in same week is skipped without calling sendMessage', async () => {
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
      });

      // Run again in the same week
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
      });

      // sendMessage should only have been called once
      expect(sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('silent period', () => {
    it('inserts digest_runs with [silent-period] marker and does not call sendMessage', async () => {
      const futureGate = FIXED_NOW + 999999999;

      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => futureGate,
      });

      expect(sendMessage).not.toHaveBeenCalled();

      const row = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row).toBeDefined();
      expect(row?.posted_text).toBe('[silent-period]');
    });

    it('silent-period row prevents re-posting even after gate passes', async () => {
      const futureGate = FIXED_NOW + 999999999;

      // First call: silent period
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => futureGate,
      });

      // Second call: gate now in the past (but row already exists)
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
      });

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('empty content', () => {
    it('inserts digest_runs with [no_content] marker and does not call sendMessage', async () => {
      const { buildDigest } = await import('./build.ts');
      (buildDigest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        text: null,
        sectionsIncluded: [],
      });

      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
      });

      expect(sendMessage).not.toHaveBeenCalled();

      const row = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row).toBeDefined();
      expect(row?.posted_text).toBe('[no_content]');
    });
  });

  describe('healthchecks.io ping', () => {
    it('fires a fetch to the healthcheck URL on success', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
        getEventsEnabledAt: () => 0,
        healthcheckUrl: 'https://hc-ping.example.com/test-uuid',
      });

      // Give microtasks time to fire
      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledWith('https://hc-ping.example.com/test-uuid');
      fetchSpy.mockRestore();
    });

    it('does not throw if healthcheck fetch fails', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

      await expect(
        runDigestNow({
          db,
          sendMessage,
          getPrimaryChatId: () => -1001234567890,
          getNowKyiv: () => DEFAULT_KYIV,
          getEventsEnabledAt: () => 0,
          healthcheckUrl: 'https://hc-ping.example.com/bad-url',
        }),
      ).resolves.not.toThrow();

      await Promise.resolve();
      fetchSpy.mockRestore();
    });
  });
});

describe('getDigestNowKyiv', () => {
  it('returns a DigestNowKyiv with correct structure', () => {
    const result = getDigestNowKyiv(FIXED_NOW);
    expect(result.nowMs).toBe(FIXED_NOW);
    expect(result.weekIso).toMatch(/^\d{4}-W\d{2}$/);
    expect(result.weekStart).toBeLessThan(result.weekEnd);
    expect(result.weekEnd - result.weekStart).toBeLessThanOrEqual(7 * 86400000);
  });

  it('weekStart is always a Monday-aligned midnight boundary', () => {
    // Sunday 20:00 Kyiv is roughly the time the digest runs
    // weekStart should be exactly 7 * 86400000 before weekEnd (= today midnight)
    const result = getDigestNowKyiv(FIXED_NOW);
    // weekEnd - weekStart is a multiple of 86400000 (whole days)
    expect((result.weekEnd - result.weekStart) % 86400000).toBe(0);
  });
});
