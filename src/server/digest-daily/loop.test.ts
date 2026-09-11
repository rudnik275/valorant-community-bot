import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { runDailyDigestNow, getKyivDate } from './loop.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { MOCK_TEXT } = vi.hoisted(() => ({
  MOCK_TEXT: '🍿 Эйсы и ножи за предыдущие 24 часа\n\n🎯 Эйсы\n- <b>Player#TAG</b> <a href="https://tracker.gg/valorant/match/m1">🦸/⛰️</a>',
}));

// The builder is covered against real SQLite in build.test.ts.
vi.mock('./build.ts', () => ({
  buildDailyAceDigest: vi.fn(),
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function getDailyRunRow(sqlite: Database.Database, runDate: string) {
  return sqlite.prepare('SELECT * FROM daily_digest_runs WHERE run_date = ?').get(runDate) as {
    id: number;
    run_date: string;
    started_at: number;
    posted_at: number | null;
    posted_message_id: number | null;
    posted_text: string | null;
    included_event_ids: string;
  } | undefined;
}

const TODAY = getKyivDate(1_746_000_000_000);

describe('runDailyDigestNow', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ db, sqlite } = makeTestDb());
    sendMessage = vi.fn().mockResolvedValue({ message_id: 7 });

    const { buildDailyAceDigest } = await import('./build.ts');
    (buildDailyAceDigest as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: MOCK_TEXT,
      includedEventIds: [42],
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  describe('happy path — non-null text', () => {
    it('calls sendMessage and writes row with posted_at and message_id', async () => {
      await runDailyDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -100123456789,
      });

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        -100123456789,
        MOCK_TEXT,
        expect.objectContaining({ parse_mode: 'HTML', disable_web_page_preview: true }),
      );

      const runDate = getKyivDate();
      const row = getDailyRunRow(sqlite, runDate);
      expect(row).toBeDefined();
      expect(row?.posted_at).not.toBeNull();
      expect(row?.posted_message_id).toBe(7);
      expect(row?.posted_text).toBe(MOCK_TEXT);
      expect(JSON.parse(row?.included_event_ids ?? '[]')).toContain(42);
    });
  });

  it('uses the rich heading on scheduled delivery when the rich sender is wired', async () => {
    const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 17 });
    await runDailyDigestNow({ db, sendMessage, sendRichMessage, getPrimaryChatId: () => -100123456789 });
    expect(sendRichMessage).toHaveBeenCalledWith(-100123456789,
      expect.stringContaining('<h2>🍿 Эйсы и ножи за предыдущие 24 часа</h2>'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getDailyRunRow(sqlite, getKyivDate())?.posted_message_id).toBe(17);
  });

  it('sends a long digest in complete rows and records the run after the final part', async () => {
    const { buildDailyAceDigest } = await import('./build.ts');
    const text = '🍿 Эйсы и ножи за предыдущие 24 часа\n\n🔪 Ножи\n' +
      Array.from({ length: 200 }, (_, i) => `- <b>LongPlayerName16#TAG</b> <a href="https://tracker.gg/valorant/match/m${i}">🦸/⛰️</a>`).join('\n');
    vi.mocked(buildDailyAceDigest).mockResolvedValueOnce({ text, includedEventIds: [42] });
    let messageId = 20;
    sendMessage.mockImplementation(async () => {
      expect(getDailyRunRow(sqlite, getKyivDate())).toBeUndefined();
      return { message_id: ++messageId };
    });
    await runDailyDigestNow({ db, sendMessage, getPrimaryChatId: () => -100123456789 });
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    const chunks = sendMessage.mock.calls.map((call) => call[1] as string);
    expect(chunks.join('\n')).toBe(text);
    expect(getDailyRunRow(sqlite, getKyivDate())?.posted_message_id).toBe(messageId);
    expect(getDailyRunRow(sqlite, getKyivDate())?.posted_text).toBe(text);
  });

  describe('zero-ace day', () => {
    it('inserts row with posted_at set but no message_id or text when build returns null', async () => {
      const { buildDailyAceDigest } = await import('./build.ts');
      (buildDailyAceDigest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        text: null,
        includedEventIds: [],
      });

      await runDailyDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -100123456789,
      });

      expect(sendMessage).not.toHaveBeenCalled();

      const runDate = getKyivDate();
      const row = getDailyRunRow(sqlite, runDate);
      expect(row).toBeDefined();
      expect(row?.posted_at).not.toBeNull();
      expect(row?.posted_message_id).toBeNull();
      expect(row?.posted_text).toBeNull();
    });
  });

  describe('idempotency — UNIQUE constraint prevents double-post', () => {
    it('second runDailyDigestNow on the same day is a no-op', async () => {
      await runDailyDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -100123456789,
      });

      // Second run on same day
      await runDailyDigestNow({
        db,
        sendMessage,
        getPrimaryChatId: () => -100123456789,
      });

      // sendMessage should only have been called once
      expect(sendMessage).toHaveBeenCalledOnce();
    });
  });
});

describe('getKyivDate', () => {
  it('returns a YYYY-MM-DD string', () => {
    const date = getKyivDate(1_746_000_000_000);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns the same date string when called twice with same ms', () => {
    const d1 = getKyivDate(1_746_000_000_000);
    const d2 = getKyivDate(1_746_000_000_000);
    expect(d1).toBe(d2);
  });

  it('returns different dates for ms spanning midnight in Kyiv', () => {
    // Use a known midnight boundary: 2026-04-28 00:00:00 Kyiv = UTC 2026-04-27 21:00:00
    // UTC 2026-04-27T21:00:00.000Z = 1777323600000
    const kyivMidnight = 1777323600000;
    const beforeMidnight = kyivMidnight - 1000; // 1 second before Kyiv midnight → still Apr 27
    const afterMidnight = kyivMidnight + 1000; // 1 second after → Apr 28
    const d1 = getKyivDate(beforeMidnight);
    const d2 = getKyivDate(afterMidnight);
    expect(d1).toBe('2026-04-27');
    expect(d2).toBe('2026-04-28');
    expect(d1).not.toBe(d2);
  });
});

describe('idempotency: TODAY constant', () => {
  it('TODAY constant has correct format', () => {
    expect(TODAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
