import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { Cron } from 'croner';
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

// Europe/Kyiv 2026 DST: clocks jump forward Sun 2026-03-29 (EET→EEST) and back
// Sun 2026-10-25 (EEST→EET). These are the instants the weekly cron actually
// fires on either side of each switch — 167h apart in spring, 169h in autumn.
const SPRING_TICKS = [Date.UTC(2026, 2, 27, 17), Date.UTC(2026, 3, 3, 16)];
const AUTUMN_TICKS = [Date.UTC(2026, 9, 23, 16), Date.UTC(2026, 9, 30, 17)];

/** The instants Croner schedules the weekly digest on, straight from the scheduler. */
function weeklyCronTicks(fromMs: number, count: number): number[] {
  return new Cron('0 19 * * 5', { timezone: 'Europe/Kyiv' })
    .nextRuns(count, new Date(fromMs))
    .map((d) => d.getTime());
}

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
    vi.unstubAllEnvs();
  });

  describe('happy path', () => {
    it('posts digest and fills digest_runs row', async () => {
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
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

  describe('send-failure recovery', () => {
    it('does NOT insert digest_runs when sendMessage throws — next attempt can still publish', async () => {
      sendMessage.mockRejectedValueOnce(new Error('Telegram outage'));

      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      // No digest_runs row should exist for this week — the week is NOT poisoned.
      const row = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row).toBeUndefined();

      // A subsequent attempt (same week) now succeeds — confirms recovery.
      sendMessage.mockResolvedValueOnce({ message_id: 99 });
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
      const row2 = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row2?.posted_message_id).toBe(99);
    });
  });

  describe('idempotency — same week twice', () => {
    it('second runDigestNow in same week is skipped without calling sendMessage', async () => {
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      // Run again in the same week
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      // sendMessage should only have been called once
      expect(sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('silent period', () => {
    it('inserts digest_runs with [silent-period] marker and does not call sendMessage', async () => {
      const future = new Date(FIXED_NOW + 999999999).toISOString();
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);

      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      expect(sendMessage).not.toHaveBeenCalled();

      const row = getDigestRunRow(sqlite, FIXED_WEEK_ISO);
      expect(row).toBeDefined();
      expect(row?.posted_text).toBe('[silent-period]');
    });

    it('silent-period row prevents re-posting even after gate passes', async () => {
      const future = new Date(FIXED_NOW + 999999999).toISOString();
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);

      // First call: silent period
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
      });

      // Second call: gate now in the past (but row already exists)
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', '');
      await runDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -1001234567890,
        getNowKyiv: () => DEFAULT_KYIV,
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

  it('weekEnd is the publication moment, snapped to the start of its minute', () => {
    // The snap is what makes consecutive windows tile exactly: croner hands us
    // the true Date.now(), and two ticks differ by a few ms of jitter.
    expect(getDigestNowKyiv(FIXED_NOW).weekEnd).toBe(FIXED_NOW);
    expect(getDigestNowKyiv(FIXED_NOW + 1234).weekEnd).toBe(FIXED_NOW);
    expect(getDigestNowKyiv(FIXED_NOW + 1234).nowMs).toBe(FIXED_NOW + 1234);
  });

  it('weekStart is exactly 7 days before weekEnd (rolling 7-day window)', () => {
    const result = getDigestNowKyiv(FIXED_NOW);
    expect(result.weekEnd - result.weekStart).toBe(7 * 86400000);
  });

  it('produces a valid ISO week identifier for two different Fridays', () => {
    // Friday 2026-05-08 19:00 Kyiv ~ UTC 16:00 = 1746716400000
    const fri1 = 1746716400000;
    const r1 = getDigestNowKyiv(fri1);
    expect(r1.weekIso).toMatch(/^\d{4}-W\d{2}$/);
    expect(r1.weekEnd).toBe(fri1);
    expect(r1.weekStart).toBe(fri1 - 7 * 86400000);

    // A week later
    const fri2 = fri1 + 7 * 86400000;
    const r2 = getDigestNowKyiv(fri2);
    expect(r2.weekIso).not.toBe(r1.weekIso); // different ISO week
    expect(r2.weekEnd).toBe(fri2);
    expect(r2.weekStart).toBe(fri2 - 7 * 86400000);
  });

  describe('DST — the window follows the cron, not a fixed 7 × 24h', () => {
    it('the pinned instants are the ones Croner really fires the digest on', () => {
      expect(weeklyCronTicks(Date.UTC(2026, 2, 25), 2)).toEqual(SPRING_TICKS);
      expect(weeklyCronTicks(Date.UTC(2026, 9, 21), 2)).toEqual(AUTUMN_TICKS);
      // 167h across the spring forward, 169h across the autumn back — this is
      // precisely why a fixed 7 × 86400000 window cannot line up with the cron.
      expect(SPRING_TICKS[1]! - SPRING_TICKS[0]!).toBe(167 * 3600000);
      expect(AUTUMN_TICKS[1]! - AUTUMN_TICKS[0]!).toBe(169 * 3600000);
    });

    it('spring forward: the next window starts exactly where the previous ended', () => {
      const prev = getDigestNowKyiv(SPRING_TICKS[0]!);
      const next = getDigestNowKyiv(SPRING_TICKS[1]!);
      expect(next.weekStart).toBe(prev.weekEnd);
      expect(next.weekEnd - next.weekStart).toBe(167 * 3600000);
      // The hour that used to be aggregated into BOTH digests: Fri 2026-03-27
      // 18:30 Kyiv. It belongs to the earlier digest and to that one only.
      const inOverlapHour = Date.UTC(2026, 2, 27, 16, 30);
      expect(inOverlapHour >= prev.weekStart && inOverlapHour < prev.weekEnd).toBe(true);
      expect(inOverlapHour >= next.weekStart && inOverlapHour < next.weekEnd).toBe(false);
    });

    it('autumn back: the next window starts exactly where the previous ended', () => {
      const prev = getDigestNowKyiv(AUTUMN_TICKS[0]!);
      const next = getDigestNowKyiv(AUTUMN_TICKS[1]!);
      expect(next.weekStart).toBe(prev.weekEnd);
      expect(next.weekEnd - next.weekStart).toBe(169 * 3600000);
      // The hour that used to fall out of BOTH digests: Fri 2026-10-23 19:30
      // Kyiv. It belongs to the later digest and is not lost.
      const inGapHour = Date.UTC(2026, 9, 23, 16, 30);
      expect(inGapHour >= prev.weekStart && inGapHour < prev.weekEnd).toBe(false);
      expect(inGapHour >= next.weekStart && inGapHour < next.weekEnd).toBe(true);
    });

    it('every consecutive pair of weekly ticks tiles exactly, DST or not', () => {
      // Two full years of real cron ticks: no hour is ever aggregated twice and
      // none is ever skipped.
      const ticks = weeklyCronTicks(Date.UTC(2026, 0, 1), 104);
      for (let i = 1; i < ticks.length; i++) {
        const prev = getDigestNowKyiv(ticks[i - 1]!);
        const next = getDigestNowKyiv(ticks[i]!);
        expect(next.weekStart, `tick ${i}`).toBe(prev.weekEnd);
      }
    });
  });
});
