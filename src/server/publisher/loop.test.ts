import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { startPublisherLoop } from './loop.ts';
import type { KyivTime } from './loop.ts';

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
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

// Seed helpers
function seedUser(sqlite: Database.Database, id: number, puuid: string, opts: { riotName?: string; riotTag?: string } = {}) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, puuid, opts.riotName ?? `Player${id}`, opts.riotTag ?? 'TAG', Date.now());
}

function seedOptOut(sqlite: Database.Database, telegramId: number, disabled: 0 | 1) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO opt_outs (telegram_id, chat_realtime_disabled, updated_at)
     VALUES (?, ?, ?)`,
  ).run(telegramId, disabled, Date.now());
}

function seedPendingEvent(
  sqlite: Database.Database,
  opts: {
    puuid: string;
    eventType?: string;
    matchId?: string;
    detectedAt?: number;
    payload?: Record<string, unknown>;
  },
): number {
  const result = sqlite.prepare(
    `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(
    opts.eventType ?? 'ace',
    opts.puuid,
    opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
    JSON.stringify(opts.payload ?? {}),
    opts.detectedAt ?? Date.now(),
  );
  return result.lastInsertRowid as number;
}

function getEventStatus(sqlite: Database.Database, eventId: number): string {
  const row = sqlite.prepare('SELECT status FROM detected_events WHERE id = ?').get(eventId) as { status: string } | undefined;
  return row?.status ?? 'NOT_FOUND';
}

function getAllEventStatuses(sqlite: Database.Database): { id: number; status: string }[] {
  return sqlite.prepare('SELECT id, status FROM detected_events ORDER BY id').all() as { id: number; status: string }[];
}

// Clock helpers
const AFTER_NOON_KYIV: KyivTime = { hour: 14, today_start_ms: 0 };

function makeLoop(
  db: ReturnType<typeof makeTestDb>['db'],
  sendMessage: ReturnType<typeof vi.fn>,
  opts: {
    primaryChatId?: number;
    kyivTime?: KyivTime;
  } = {},
) {
  const getNowKyiv = vi.fn().mockReturnValue(opts.kyivTime ?? { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 });
  const getPrimaryChatId = vi.fn().mockReturnValue(opts.primaryChatId ?? -1001234567890);

  return {
    getNowKyiv,
    getPrimaryChatId,
    stop: startPublisherLoop({
      db,
      sendMessage,
      getNowKyiv: () => getNowKyiv(),
      getPrimaryChatId: () => getPrimaryChatId(),
      intervalCron: '* * * * * *', // every second for tests — but we call runTick manually via cron
    }),
  };
}

describe('startPublisherLoop', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  // Helper: run one tick synchronously by advancing cron timer and flushing
  async function runOneTick(loopStop: () => void) {
    // Advance 1s to trigger the cron expression `* * * * * *`
    await vi.advanceTimersByTimeAsync(1001);
    // Flush all microtasks/promises
    for (let i = 0; i < 10; i++) await Promise.resolve();
    loopStop();
  }

  describe('EVENTS_PUBLISHING_ENABLED_AFTER gate', () => {
    it('marks all pending events as silent when publishing not yet enabled', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'winstreak_9' });

      const future = new Date(Date.now() + 999999999).toISOString();
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('silent');
      expect(getEventStatus(sqlite, id2)).toBe('silent');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does NOT silence events when publishing is enabled (past threshold)', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const past = new Date(Date.now() - 1000).toISOString(); // already in the past
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', past);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('posts events at any hour', () => {
    it('posts events before noon (no quiet hours gate)', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { hour: 10, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('posts events after noon', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { hour: 14, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('posted');
    });
  });

  describe('opt-out', () => {
    it('marks event as opted-out when user has disabled realtime notifications', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedOptOut(sqlite, 1, 1);
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('opted-out');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('posts event when user has chat_realtime_disabled=0', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedOptOut(sqlite, 1, 0);
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('posted');
    });
  });

  describe('no pending events', () => {
    it('does nothing when no pending events exist', async () => {
      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('processes oldest event first', () => {
    it('picks event with smallest detected_at', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedUser(sqlite, 2, 'puuid-2');

      const now = Date.now();
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace', detectedAt: now - 5000 });
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-2', eventType: 'winstreak_9', detectedAt: now - 1000 });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: now - 86400000 },
      });

      await runOneTick(stop);

      // id1 is older → posted first
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('pending');
    });
  });

  describe('Telegram 429 retry', () => {
    it('retries once on 429 and succeeds', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const retryAfterError = Object.assign(new Error('429 Too Many Requests: retry after 2'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });

      // Use a long cron interval so only one tick fires during the test
      const getNowKyiv = vi.fn().mockReturnValue({ ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 });
      const stop = startPublisherLoop({
        db,
        sendMessage,
        getNowKyiv: () => getNowKyiv(),
        getPrimaryChatId: () => -1001234567890,
        intervalCron: '0 0 1 1 *', // effectively never fires again after first tick
      });

      sendMessage
        .mockRejectedValueOnce(retryAfterError)
        .mockResolvedValueOnce({ message_id: 100 });

      // Trigger first tick immediately
      // Croner with '0 0 1 1 *' won't fire on its own in tests, so advance enough
      // to trigger via a more testable cron - instead use every-second but stop quickly
      stop();

      // Use direct approach: test the retry logic separately from the loop
      // by running one cron second-interval tick with long cron after
      const stop2 = startPublisherLoop({
        db,
        sendMessage,
        getNowKyiv: () => getNowKyiv(),
        getPrimaryChatId: () => -1001234567890,
        intervalCron: '* * * * * *',
      });

      // Start the cron tick (at t=1001ms)
      await vi.advanceTimersByTimeAsync(1001);
      // Let the tick start and hit the first sendMessage call
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Stop the loop NOW so no second tick fires during the retry sleep
      stop2();

      // Advance past retry_after (1 second) — no more cron ticks since loop is stopped
      await vi.advanceTimersByTimeAsync(1100);
      // Flush remaining microtasks for the retry
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(getEventStatus(sqlite, id1)).toBe('posted');
    });

    it('leaves event as pending on non-429 error (no retry)', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      sendMessage.mockRejectedValueOnce(new Error('Network error'));

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(getEventStatus(sqlite, id1)).toBe('pending');
    });

    it('leaves event as pending if both 429 retry attempts fail', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });

      sendMessage.mockRejectedValue(retryAfterError);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await vi.advanceTimersByTimeAsync(1001);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1100);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      stop();

      // Both attempts failed — event stays pending
      expect(getEventStatus(sqlite, id1)).toBe('pending');
    });
  });

  describe('message content', () => {
    it('calls sendMessage with HTML parse_mode', async () => {
      seedUser(sqlite, 1, 'puuid-1', { riotName: 'TestPlayer', riotTag: '1234' });
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledWith(
        expect.any(Number),
        expect.stringContaining('TestPlayer'),
        expect.objectContaining({ parse_mode: 'HTML', disable_web_page_preview: true }),
      );
    });

    it('sends to the primary chat ID', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      const primaryChatId = -9998887776665;
      const { stop } = makeLoop(db, sendMessage, {
        primaryChatId,
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledWith(
        primaryChatId,
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  describe('silent-period gate (EVENTS_PUBLISHING_ENABLED_AFTER)', () => {
    it('marks multiple pending events as silent when gate is in future', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedUser(sqlite, 2, 'puuid-2');

      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-2', eventType: 'winstreak_9' });
      const id3 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      const future = new Date(Date.now() + 999999).toISOString();
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      const statuses = getAllEventStatuses(sqlite);
      for (const row of statuses) {
        expect(row.status).toBe('silent');
      }
      expect(sendMessage).not.toHaveBeenCalled();

      void id1; void id2; void id3;
    });
  });

  describe('stop function', () => {
    it('stops the loop (no further ticks after stop)', async () => {
      seedUser(sqlite, 1, 'puuid-1');

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      stop(); // stop before any tick

      // Add event after stopping
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });

      await vi.advanceTimersByTimeAsync(5000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
