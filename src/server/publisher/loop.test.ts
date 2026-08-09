import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { startPublisherLoop } from './loop.ts';
import type { KyivTime } from './loop.ts';
import { rankToEmojiHtml } from './rank-emoji.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from './valorant-emoji.ts';

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
    /** Defaults to 0 — most tests want an event published on the next tick. */
    publishGraceMs?: number;
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
      publishGraceMs: opts.publishGraceMs ?? 0,
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
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'winstreak_10plus' });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { hour: 10, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('posts events after noon', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill', detectedAt: now - 5000 });
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-2', eventType: 'winstreak_10plus', detectedAt: now - 1000 });

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
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
        publishGraceMs: 0,
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

    it('leaves event as pending + bumps failed_attempts on durable Telegram 4xx', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      // Durable 400 (e.g. "chat not found"): no error_code retry, no transient kind.
      const durable400 = Object.assign(new Error('Bad Request: chat not found'), {
        error_code: 400,
      });
      sendMessage.mockRejectedValueOnce(durable400);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      // Durable error → no retry call.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(getEventStatus(sqlite, id1)).toBe('pending');

      // failed_attempts bumped to 1, last_error captured.
      const row = sqlite.prepare(
        'SELECT failed_attempts, last_error FROM detected_events WHERE id = ?',
      ).get(id1) as { failed_attempts: number; last_error: string };
      expect(row.failed_attempts).toBe(1);
      expect(row.last_error).toContain('chat not found');
    });

    it('parks event as failed after MAX_FAILED_ATTEMPTS=3 so queue stops blocking', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      // Two pending events; first is poison, second should still get a chance later.
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      // Pretend this poison event has already failed twice — next failure should park it.
      sqlite.prepare('UPDATE detected_events SET failed_attempts = 2 WHERE id = ?').run(id1);

      const durable400 = Object.assign(new Error('Bad Request: message is too long'), {
        error_code: 400,
      });
      sendMessage.mockRejectedValueOnce(durable400);

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('failed');
      const row = sqlite.prepare(
        'SELECT failed_attempts, last_error FROM detected_events WHERE id = ?',
      ).get(id1) as { failed_attempts: number; last_error: string };
      expect(row.failed_attempts).toBe(3);
      expect(row.last_error).toContain('too long');
    });

    it('retries on transient Telegram 5xx error before giving up', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      const transient500 = Object.assign(new Error('Internal Server Error'), { error_code: 500 });
      sendMessage
        .mockRejectedValueOnce(transient500)
        .mockResolvedValueOnce({ message_id: 999 });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      // Step 1: Advance 1s — fires exactly one cron tick.
      // Tick: sendMessage 1st call (rejects 5xx) → starts the retry sleep(2000).
      await vi.advanceTimersByTimeAsync(1001);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Cancel the cron so subsequent advance doesn't fire additional ticks
      // (which would consume more mock entries and break the call-count check).
      // The in-flight tick is unaffected — its setTimeout sleep keeps running.
      stop();
      // Step 2: Drive the 2s retry sleep to completion → 2nd sendMessage succeeds.
      await vi.advanceTimersByTimeAsync(2100);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(getEventStatus(sqlite, id1)).toBe('posted');
    });

    it('leaves event as pending if both 429 retry attempts fail', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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

    it('includes a tracker.gg match link in the rendered message', async () => {
      // Regression: publisher previously passed only { map } to the template,
      // not match_id — so realtime events posted to the group had no link
      // even though /test_runtime_events (which passes both) did.
      seedUser(sqlite, 1, 'puuid-1', { riotName: 'Linker', riotTag: '0001' });
      const matchId = 'abc-match-id-with-link-001';
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill', matchId });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });

      await runOneTick(stop);

      const [, body] = sendMessage.mock.calls[0]!;
      expect(body).toContain(`tracker.gg/valorant/match/${matchId}`);
      expect(body).toContain('>матч</a>');
    });

    it('sends to the primary chat ID', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

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

  // ── #315 minimal trio data plumbing (rank / roster victims / own-line link) ──
  describe('minimal trio data plumbing (#315)', () => {
    const MATCH = 'match-tk-315';

    function seedTkMatchRecord(puuid: string, rankAfter: string | null) {
      sqlite.prepare(
        `INSERT INTO match_records
           (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
            rounds_played, rank_after, fall_damage_kills, kill_events_compact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(puuid, MATCH, 1_000, 'Ascent', 'Jett', 20, 10, 5, 'win', 24, rankAfter, 0, '[]');
    }

    function seedRosterVictim(puuid: string, name: string, tag: string, agent: string, tier: string | null) {
      sqlite.prepare(
        `INSERT INTO match_rosters (match_id, riot_puuid, team, name, tag, agent, tier, kills, deaths)
         VALUES (?, ?, 'Blue', ?, ?, ?, ?, 10, 10)`,
      ).run(MATCH, puuid, name, tag, agent, tier);
    }

    it('teamkill: killer rank+agent, victim Ник#Тег with roster rank/agent, link on its own line', async () => {
      seedUser(sqlite, 1, 'killer-1', { riotName: 'Killer', riotTag: 'KKK' });
      seedUser(sqlite, 2, 'victim-1', { riotName: 'Danya', riotTag: 'UA1' });
      seedTkMatchRecord('killer-1', 'Diamond 3');
      seedRosterVictim('victim-1', 'Danya', 'UA1', 'Sage', 'Silver 2');
      seedPendingEvent(sqlite, {
        puuid: 'killer-1',
        eventType: 'teamkill',
        matchId: MATCH,
        payload: {
          round_numbers: [3],
          victims: [{ puuid: 'victim-1', name: 'Danya', tag: 'UA1', agent: 'Sage' }],
        },
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      const [, body] = sendMessage.mock.calls[0]!;
      // Title / blank / body / blank / link — the short events are
      // blank-line separated since 2026-08-04.
      const lines = (body as string).split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('🐀 <b>Ля ты и крыса</b>');
      expect(lines[1]).toBe('');
      // Killer: rank (match_records.rank_after) left, bold Ник#Тег, agent right.
      expect(lines[2]).toContain(`${rankToEmojiHtml('Diamond 3')} <b>Killer#KKK</b> ${agentToEmojiHtml('Jett')}`);
      // Victim: full Ник#Тег via renderPlayerName, rank from roster tier.
      expect(lines[2]).toContain(`(${rankToEmojiHtml('Silver 2')} <b>Danya#UA1</b> ${agentToEmojiHtml('Sage')})`);
      expect(lines[3]).toBe('');
      // Match link alone on the last line.
      expect(lines[4]).toBe(`<a href="https://tracker.gg/valorant/match/${MATCH}">${mapToEmojiHtml('Ascent')} Ascent</a>`);
    });

    it('teamkill: old event with no roster/match rows still posts (icons omitted, no crash)', async () => {
      seedUser(sqlite, 1, 'killer-1', { riotName: 'Killer', riotTag: 'KKK' });
      const id = seedPendingEvent(sqlite, {
        puuid: 'killer-1',
        eventType: 'teamkill',
        matchId: 'missing-match',
        payload: { victim_names_for_template: ['Ghost'] },
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(getEventStatus(sqlite, id)).toBe('posted');
      const [, body] = sendMessage.mock.calls[0]!;
      expect(body).toContain('<b>Ghost</b>');
      expect(body).not.toContain('<tg-emoji');
    });
  });

  describe('silent-period gate (EVENTS_PUBLISHING_ENABLED_AFTER)', () => {
    it('marks multiple pending events as silent when gate is in future', async () => {
      seedUser(sqlite, 1, 'puuid-1');
      seedUser(sqlite, 2, 'puuid-2');

      const id1 = seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'ace' });
      const id2 = seedPendingEvent(sqlite, { puuid: 'puuid-2', eventType: 'winstreak_10plus' });
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
      seedPendingEvent(sqlite, { puuid: 'puuid-1', eventType: 'teamkill' });

      await vi.advanceTimersByTimeAsync(5000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  // ── #315 "trio" rich path (giant_slayer / match_comeback / community_clash) ──
  describe('rich full-roster events', () => {
    const MATCH = 'match-trio';

    /** Seed a match_record for the community player (drives map/agent lookup). */
    function seedMatchRecord(puuid: string, map: string) {
      sqlite.prepare(
        `INSERT INTO match_records
           (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
            rounds_played, fall_damage_kills, kill_events_compact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(puuid, MATCH, 1_000, map, 'Jett', 20, 10, 5, 'win', 24, 0, '[]');
    }

    /** Seed a full 10-player roster with tier/kills/deaths (complete for rich). */
    function seedFullRoster(complete: boolean) {
      const rows = [
        ['a1', 'Blue', 'Alice', 'AAA', 'Jett'],
        ['a2', 'Blue', 'Bob', 'BBB', 'Sova'],
        ['a3', 'Blue', 'C', 'CCC', 'Omen'],
        ['a4', 'Blue', 'D', 'DDD', 'Sage'],
        ['a5', 'Blue', 'E', 'EEE', 'Reyna'],
        ['b1', 'Red', 'F', 'FFF', 'Jett'],
        ['b2', 'Red', 'G', 'GGG', 'Sova'],
        ['b3', 'Red', 'H', 'HHH', 'Omen'],
        ['b4', 'Red', 'I', 'III', 'Sage'],
        ['b5', 'Red', 'J', 'JJJ', 'Reyna'],
      ];
      for (const [puuid, team, name, tag, agent] of rows) {
        sqlite.prepare(
          `INSERT INTO match_rosters (match_id, riot_puuid, team, name, tag, agent, tier, kills, deaths)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          MATCH, puuid, team, name, tag, agent,
          complete ? 'Diamond 2' : null,
          complete ? 20 : null,
          complete ? 14 : null,
        );
      }
    }

    function makeRichLoop(sendRichMessage: ReturnType<typeof vi.fn>) {
      return startPublisherLoop({
        db,
        sendMessage,
        sendRichMessage,
        getNowKyiv: () => ({ ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 }),
        getPrimaryChatId: () => -1001234567890,
        intervalCron: '* * * * * *',
        publishGraceMs: 0,
      });
    }

    it('posts a trio event via the rich path when the roster is complete', async () => {
      seedUser(sqlite, 1, 'a1'); // Alice is the community trigger
      seedMatchRecord('a1', 'Ascent');
      seedFullRoster(true);
      const id = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'community_clash', matchId: MATCH,
        payload: { winner_team_id: 'Blue', team_scores: { Blue: { won: 13, lost: 11 }, Red: { won: 11, lost: 13 } } },
      });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      // Rich send used; plain send NOT used.
      expect(sendRich).toHaveBeenCalledTimes(1);
      const richHtml = sendRich.mock.calls[0]![1] as string;
      expect(richHtml).toContain('<table>');
      expect(richHtml).toContain('⚔️ <b>Френдлифаер</b>');
      expect(richHtml).toContain('победа 13:11');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getEventStatus(sqlite, id)).toBe('posted');
    });

    it('falls back to the legacy plain template when the rich send throws', async () => {
      seedUser(sqlite, 1, 'a1');
      seedMatchRecord('a1', 'Ascent');
      seedFullRoster(true);
      const id = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'community_clash', matchId: MATCH,
        payload: { winner_team_id: 'Blue', team_scores: { Blue: { won: 13, lost: 11 }, Red: { won: 11, lost: 13 } } },
      });

      const sendRich = vi.fn().mockRejectedValue(new Error('rich API down'));
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      // Rich attempted, then plain fallback fired and the event still posted.
      expect(sendRich).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![1]).toContain('Френдлифаер');
      expect(getEventStatus(sqlite, id)).toBe('posted');
    });

    it('falls back to plain when the roster is incomplete (rich renders null)', async () => {
      seedUser(sqlite, 1, 'a1');
      seedMatchRecord('a1', 'Ascent');
      seedFullRoster(false); // tier/kills/deaths null → rich returns null
      const id = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'community_clash', matchId: MATCH,
        payload: { winner_team_id: 'Blue' },
      });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      // Rich never sent (null html); plain path used.
      expect(sendRich).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(getEventStatus(sqlite, id)).toBe('posted');
    });

    it('uses the plain path (no rich) for non-trio realtime events', async () => {
      seedUser(sqlite, 1, 'a1');
      const id = seedPendingEvent(sqlite, { puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {} });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      expect(sendRich).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(getEventStatus(sqlite, id)).toBe('posted');
    });

    it('falls back to plain when no sendRichMessage dep is wired', async () => {
      seedUser(sqlite, 1, 'a1');
      seedMatchRecord('a1', 'Ascent');
      seedFullRoster(true);
      const id = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'community_clash', matchId: MATCH,
        payload: { winner_team_id: 'Blue' },
      });

      // makeLoop wires NO sendRichMessage.
      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(getEventStatus(sqlite, id)).toBe('posted');
    });
  });

  // ── Per-match uniqueness: one message per (match, event type) ────────────
  //
  // Each community player is scanned separately, so a match with several of
  // them produces several detected_events rows. The group must still see ONE
  // message: «💪 Поводил(ла) по губам» and «👏 Мы вами гордимся» both posted
  // twice for a single match (owner, 2026-08-09).
  describe('per-match uniqueness', () => {
    const MATCH = 'match-dupes';

    function seedMatchRecord(puuid: string, matchId = MATCH, map = 'Ascent') {
      sqlite.prepare(
        `INSERT INTO match_records
           (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
            rounds_played, fall_damage_kills, kill_events_compact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(puuid, matchId, 1_000, map, 'Jett', 20, 10, 5, 'win', 24, 0, '[]');
    }

    function seedFullRoster(matchId = MATCH) {
      const rows = [
        ['a1', 'Blue', 'Alice', 'AAA', 'Jett'],
        ['a2', 'Blue', 'Bob', 'BBB', 'Sova'],
        ['a3', 'Blue', 'C', 'CCC', 'Omen'],
        ['a4', 'Blue', 'D', 'DDD', 'Sage'],
        ['a5', 'Blue', 'E', 'EEE', 'Reyna'],
        ['b1', 'Red', 'F', 'FFF', 'Jett'],
        ['b2', 'Red', 'G', 'GGG', 'Sova'],
        ['b3', 'Red', 'H', 'HHH', 'Omen'],
        ['b4', 'Red', 'I', 'III', 'Sage'],
        ['b5', 'Red', 'J', 'JJJ', 'Reyna'],
      ];
      for (const [puuid, team, name, tag, agent] of rows) {
        sqlite.prepare(
          `INSERT INTO match_rosters (match_id, riot_puuid, team, name, tag, agent, tier, kills, deaths)
           VALUES (?, ?, ?, ?, ?, ?, 'Diamond 2', 20, 14)`,
        ).run(matchId, puuid, team, name, tag, agent);
      }
    }

    function seedPostedEvent(opts: { puuid: string; eventType: string; matchId: string }): number {
      const result = sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status, posted_message_id)
         VALUES (?, ?, ?, '{}', ?, 'posted', 777)`,
      ).run(opts.eventType, opts.puuid, opts.matchId, Date.now() - 60_000);
      return result.lastInsertRowid as number;
    }

    function getPostedMessageId(eventId: number): number | null {
      const row = sqlite
        .prepare('SELECT posted_message_id FROM detected_events WHERE id = ?')
        .get(eventId) as { posted_message_id: number | null } | undefined;
      return row?.posted_message_id ?? null;
    }

    function makeRichLoop(sendRichMessage: ReturnType<typeof vi.fn>) {
      return startPublisherLoop({
        db,
        sendMessage,
        sendRichMessage,
        getNowKyiv: () => ({ ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 }),
        getPrimaryChatId: () => -1001234567890,
        intervalCron: '* * * * * *',
        publishGraceMs: 0,
      });
    }

    it('posts ONE giant_slayer message naming both community players', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      seedMatchRecord('a1');
      seedMatchRecord('a2');
      seedFullRoster();
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'giant_slayer', matchId: MATCH,
        payload: { own: 'Diamond 2', enemy_avg: 'Immortal 1' }, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'giant_slayer', matchId: MATCH,
        payload: { own: 'Diamond 2', enemy_avg: 'Immortal 1' }, detectedAt: 1_100,
      });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      expect(sendRich).toHaveBeenCalledTimes(1);
      const html = sendRich.mock.calls[0]![1] as string;
      // One title, both heroes named under it. Assert against the HEADER — the
      // part above the roster table — because the table lists all ten players
      // anyway, so a whole-message `toContain` would pass without the fix.
      expect(html.match(/💪 <b>Поводил\(ла\) по губам<\/b>/g)).toHaveLength(1);
      const header = html.slice(0, html.indexOf('<table>'));
      expect(header).toContain('<b>Alice#AAA</b>');
      expect(header).toContain('<b>Bob#BBB</b>');
      // Both rows close out together, on the same message.
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('posted');
      expect(getPostedMessageId(id1)).toBe(99);
      expect(getPostedMessageId(id2)).toBe(99);
    });

    it('never posts a second message on a later tick for the same match', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      seedMatchRecord('a1');
      seedMatchRecord('a2');
      seedFullRoster();
      seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'giant_slayer', matchId: MATCH, payload: {}, detectedAt: 1_000,
      });
      seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'giant_slayer', matchId: MATCH, payload: {}, detectedAt: 1_100,
      });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      // Three ticks: whatever the queue does, the chat gets one post.
      await vi.advanceTimersByTimeAsync(3001);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      stop();

      expect(sendRich).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses a straggler whose scan landed after the match was posted', async () => {
      // The late-scan case: player B's event is detected a tick after A's
      // message went out. Repeating the post is exactly the reported spam.
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      seedMatchRecord('a2');
      seedFullRoster();
      seedPostedEvent({ puuid: 'a1', eventType: 'giant_slayer', matchId: MATCH });
      const straggler = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'giant_slayer', matchId: MATCH, payload: {},
      });

      const sendRich = vi.fn().mockResolvedValue({ message_id: 99 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      expect(sendRich).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getEventStatus(sqlite, straggler)).toBe('silent');
    });

    it('posts ONE match_comeback message for a whole team of community players', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      seedUser(sqlite, 3, 'a3', { riotName: 'Carol', riotTag: 'CCC' });
      seedMatchRecord('a1');
      seedMatchRecord('a2');
      seedMatchRecord('a3');
      seedFullRoster();
      const payload = {
        deficit_score_player: 3, deficit_score_opponent: 11,
        final_score_player: 13, final_score_opponent: 11,
      };
      const ids = ['a1', 'a2', 'a3'].map((puuid, i) =>
        seedPendingEvent(sqlite, {
          puuid, eventType: 'match_comeback', matchId: MATCH, payload, detectedAt: 1_000 + i,
        }),
      );

      const sendRich = vi.fn().mockResolvedValue({ message_id: 55 });
      const stop = makeRichLoop(sendRich);
      await runOneTick(stop);

      expect(sendRich).toHaveBeenCalledTimes(1);
      expect((sendRich.mock.calls[0]![1] as string).match(/👏 <b>Мы вами гордимся<\/b>/g)).toHaveLength(1);
      for (const id of ids) expect(getEventStatus(sqlite, id)).toBe('posted');
    });

    it('groups the plain-text path too — one teamkill message, one line per killer', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH,
        payload: { victims: [{ name: 'Carol', tag: 'CCC' }] }, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'teamkill', matchId: MATCH,
        payload: { victims: [{ name: 'Dave', tag: 'DDD' }] }, detectedAt: 1_100,
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = sendMessage.mock.calls[0]![1] as string;
      expect(text.match(/🐀 <b>Ля ты и крыса<\/b>/g)).toHaveLength(1);
      expect(text).toContain('<b>Alice#AAA</b>');
      expect(text).toContain('<b>Bob#BBB</b>');
      expect(text).toContain('Carol');
      expect(text).toContain('Dave');
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('posted');
    });

    it('drops an opted-out player from the group but still posts for the rest', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      seedOptOut(sqlite, 2, 1);
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_100,
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = sendMessage.mock.calls[0]![1] as string;
      expect(text).toContain('<b>Alice#AAA</b>');
      expect(text).not.toContain('<b>Bob#BBB</b>');
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('opted-out');
    });

    it('posts nothing when every player in the group opted out', async () => {
      seedUser(sqlite, 1, 'a1');
      seedUser(sqlite, 2, 'a2');
      seedOptOut(sqlite, 1, 1);
      seedOptOut(sqlite, 2, 1);
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_100,
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(sendMessage).not.toHaveBeenCalled();
      expect(getEventStatus(sqlite, id1)).toBe('opted-out');
      expect(getEventStatus(sqlite, id2)).toBe('opted-out');
    });

    it('keeps different matches apart — one message each, not one merged', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: 'match-one', payload: {}, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: 'match-two', payload: {}, detectedAt: 1_100,
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await vi.advanceTimersByTimeAsync(2001);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      stop();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('posted');
    });

    it('keeps different event types of one match apart', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'return_after_pause', matchId: MATCH,
        payload: { days_paused: 30 }, detectedAt: 1_100,
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await vi.advanceTimersByTimeAsync(2001);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      stop();

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('posted');
    });

    it('waits out the grace period before publishing, then includes the sibling scanned later', async () => {
      // The scanner walks users one at a time, so a match's events land spread
      // across a whole sweep. Without the wait the first player is posted alone
      // and everyone scanned afterwards is suppressed as a duplicate — no double
      // post, but their names never reach the chat.
      const GRACE = 60_000;
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: Date.now(),
      });

      const { stop } = makeLoop(db, sendMessage, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
        publishGraceMs: GRACE,
      });

      // Alice's event is too young — nothing goes out yet.
      await vi.advanceTimersByTimeAsync(2001);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getEventStatus(sqlite, id1)).toBe('pending');

      // Bob's scan lands mid-grace.
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(GRACE + 2001);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      stop();

      // One message, and it names both — Bob is not lost.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const text = sendMessage.mock.calls[0]![1] as string;
      expect(text).toContain('<b>Alice#AAA</b>');
      expect(text).toContain('<b>Bob#BBB</b>');
      expect(getEventStatus(sqlite, id1)).toBe('posted');
      expect(getEventStatus(sqlite, id2)).toBe('posted');
    });

    it('leaves the whole group pending when the send fails, so the retry is still one message', async () => {
      seedUser(sqlite, 1, 'a1', { riotName: 'Alice', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'a2', { riotName: 'Bob', riotTag: 'BBB' });
      const id1 = seedPendingEvent(sqlite, {
        puuid: 'a1', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_000,
      });
      const id2 = seedPendingEvent(sqlite, {
        puuid: 'a2', eventType: 'teamkill', matchId: MATCH, payload: {}, detectedAt: 1_100,
      });

      const failing = vi.fn().mockRejectedValue(new Error('chat not found'));
      const { stop } = makeLoop(db, failing, {
        kyivTime: { ...AFTER_NOON_KYIV, today_start_ms: Date.now() - 86400000 },
      });
      await runOneTick(stop);

      expect(getEventStatus(sqlite, id1)).toBe('pending');
      expect(getEventStatus(sqlite, id2)).toBe('pending');
      const attempts = sqlite
        .prepare('SELECT failed_attempts FROM detected_events ORDER BY id')
        .all() as Array<{ failed_attempts: number }>;
      expect(attempts.map((a) => a.failed_attempts)).toEqual([1, 1]);
    });
  });
});
