/**
 * tests/e2e/publisher.spec.ts
 *
 * Integration test for the publisher loop — broader than loop.test.ts.
 * Wires the actual startPublisherLoop with in-memory DB + real migrations,
 * and asserts end-to-end behavior from DB insert through message send.
 *
 * Covers:
 * - A pending event transitions to 'posted' and sendMessage is called with
 *   HTML-templated text and correct parse_mode.
 * - Opted-out user event becomes 'opted-out' without calling sendMessage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { startPublisherLoop } from '../../src/server/publisher/loop.ts';
import type { KyivTime } from '../../src/server/publisher/loop.ts';

vi.mock('../../src/server/lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function seedUser(
  sqlite: Database.Database,
  telegramId: number,
  puuid: string,
  opts: { riotName?: string; riotTag?: string } = {},
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(telegramId, puuid, opts.riotName ?? `User${telegramId}`, opts.riotTag ?? 'TAG', Date.now());
}

function seedOptOut(sqlite: Database.Database, telegramId: number, disabled: 0 | 1) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO opt_outs (telegram_id, chat_realtime_disabled, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(telegramId, disabled, Date.now());
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
  const result = sqlite
    .prepare(
      `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      opts.eventType ?? 'ace',
      opts.puuid,
      opts.matchId ?? `e2e-match-${Date.now()}-${Math.random()}`,
      JSON.stringify(opts.payload ?? { rounds: [5] }),
      opts.detectedAt ?? Date.now(),
    );
  return result.lastInsertRowid as number;
}

function getEventStatus(sqlite: Database.Database, id: number): string {
  const row = sqlite
    .prepare('SELECT status FROM detected_events WHERE id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status ?? 'NOT_FOUND';
}

// A Kyiv time value (no longer used for quiet-hours gate, kept for interface compat)
const AFTER_NOON: KyivTime = { hour: 14, today_start_ms: 0 };

async function runOneTick(stopFn: () => void) {
  // Advance cron by 1 second (loop uses '* * * * * *' in test mode)
  await vi.advanceTimersByTimeAsync(1001);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  stopFn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('e2e: publisher loop', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
    vi.useFakeTimers();
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', ''); // publishing enabled
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('pending ace event does NOT produce a realtime message (ace is now digest-category)', async () => {
    seedUser(sqlite, 1001, 'e2e-puuid-pub-1', { riotName: 'HeroPlayer', riotTag: 'HP1' });
    const eventId = seedPendingEvent(sqlite, {
      puuid: 'e2e-puuid-pub-1',
      eventType: 'ace',
      payload: { rounds: [5, 10] },
    });

    const stop = startPublisherLoop({
      db,
      sendMessage,
      getNowKyiv: () => ({ ...AFTER_NOON, today_start_ms: Date.now() - 86400000 }),
      getPrimaryChatId: () => -1009998887776,
      intervalCron: '* * * * * *',
    });

    await runOneTick(stop);

    // Digest events that slip into the realtime queue are skipped (marked silent).
    expect(getEventStatus(sqlite, eventId)).toBe('silent');

    // sendMessage must NOT have been called — no realtime notification for ace.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('second pending event for the same user is also posted (no antispam quota)', async () => {
    seedUser(sqlite, 1002, 'e2e-puuid-pub-2');

    const now = Date.now();
    const id1 = seedPendingEvent(sqlite, {
      puuid: 'e2e-puuid-pub-2',
      eventType: 'knife_kill',
      payload: { count: 1 },
      detectedAt: now - 2000,
    });
    const id2 = seedPendingEvent(sqlite, {
      puuid: 'e2e-puuid-pub-2',
      eventType: 'giant_slayer',
      payload: { own: 'Silver 2', enemy_avg: 'Gold 1' },
      detectedAt: now - 1000,
    });

    // First tick: posts id1
    const stop1 = startPublisherLoop({
      db,
      sendMessage,
      getNowKyiv: () => ({ ...AFTER_NOON, today_start_ms: Date.now() - 86400000 }),
      getPrimaryChatId: () => -1009998887777,
      intervalCron: '* * * * * *',
    });
    await runOneTick(stop1);

    expect(getEventStatus(sqlite, id1)).toBe('posted');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second tick: id2 from same user — no quota, also posted
    const stop2 = startPublisherLoop({
      db,
      sendMessage,
      getNowKyiv: () => ({ ...AFTER_NOON, today_start_ms: Date.now() - 86400000 }),
      getPrimaryChatId: () => -1009998887777,
      intervalCron: '* * * * * *',
    });
    await runOneTick(stop2);

    expect(getEventStatus(sqlite, id2)).toBe('posted');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('opted-out user event becomes opted-out without calling sendMessage', async () => {
    seedUser(sqlite, 1003, 'e2e-puuid-pub-3');
    seedOptOut(sqlite, 1003, 1); // opted out
    const eventId = seedPendingEvent(sqlite, { puuid: 'e2e-puuid-pub-3', eventType: 'teamkill', payload: { round_numbers: [1] } });

    const stop = startPublisherLoop({
      db,
      sendMessage,
      getNowKyiv: () => ({ ...AFTER_NOON, today_start_ms: Date.now() - 86400000 }),
      getPrimaryChatId: () => -1009998887778,
      intervalCron: '* * * * * *',
    });

    await runOneTick(stop);

    expect(getEventStatus(sqlite, eventId)).toBe('opted-out');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('all 7 realtime event types render without throwing (template coverage)', async () => {
    // One user for all event types
    seedUser(sqlite, 1004, 'e2e-puuid-pub-4', { riotName: 'MultiEvent', riotTag: 'ME1' });

    const now = Date.now();
    const eventTypes = [
      ['giant_slayer',       { enemy_avg: 'Gold 1', own: 'Silver 3' }],
      ['teamkill',           { round_numbers: [2, 8], count: 2 }],
      ['fall_damage_death',  { count: 1 }],
      ['knife_kill',         { count: 1 }],
      ['match_comeback',     { deficit_score_player: 3, deficit_score_opponent: 11, final_score_player: 13, final_score_opponent: 11 }],
      ['community_clash',    { teams: [], winner_team_id: null }],
      ['return_after_pause', { days_paused: 14 }],
    ] as const;

    for (let i = 0; i < eventTypes.length; i++) {
      const [type, payload] = eventTypes[i];
      const sendMsg = vi.fn().mockResolvedValue({ message_id: 100 + i });
      const matchId = `e2e-tmpl-${type}-${i}`;

      const evtId = seedPendingEvent(sqlite, {
        puuid: 'e2e-puuid-pub-4',
        eventType: type,
        matchId,
        payload: payload as Record<string, unknown>,
        detectedAt: now + i * 1000,
      });

      const stop = startPublisherLoop({
        db,
        sendMsg,
        sendMessage: sendMsg,
        getNowKyiv: () => ({ ...AFTER_NOON, today_start_ms: now - 7 * 86400000 }),
        getPrimaryChatId: () => -1009998887779,
        intervalCron: '* * * * * *',
      } as Parameters<typeof startPublisherLoop>[0]);

      await runOneTick(stop);

      const status = getEventStatus(sqlite, evtId);
      expect(status).toBe('posted');
    }
  });
});
