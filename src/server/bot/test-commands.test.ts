import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import {
  isOwner,
  OWNER_TELEGRAM_ID,
  parseDaysArg,
  makeTestDigestHandler,
  makeTestRuntimeEventsHandler,
  collapseGroupableEvents,
} from './test-commands.ts';
import { renderTemplate } from '../publisher/templates.ts';
import { resolveTemplateMatch } from '../publisher/match-info.ts';

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

describe('/test_runtime_events replay parity (#315)', () => {
  const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');
  const MATCH = 'match-parity-1';
  const KILLER = 'puuid-killer';
  const VICTIM = 'puuid-victim';

  it('teamkill preview text is byte-identical to the production render (shared resolver)', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys=OFF;');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    try {
      sqlite.prepare(
        `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(1, KILLER, 'Killer', 'KKK', Date.now());
      sqlite.prepare(
        `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(2, VICTIM, 'Danya', 'UA1', Date.now());
      sqlite.prepare(
        `INSERT INTO match_records
           (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
            rounds_played, rank_after, fall_damage_kills, kill_events_compact)
         VALUES (?, ?, ?, 'Ascent', 'Jett', 20, 10, 5, 'win', 24, 'Diamond 3', 0, '[]')`,
      ).run(KILLER, MATCH, 1_000);
      sqlite.prepare(
        `INSERT INTO match_rosters (match_id, riot_puuid, team, name, tag, agent, tier, kills, deaths)
         VALUES (?, ?, 'Blue', 'Danya', 'UA1', 'Sage', 'Silver 2', 10, 10)`,
      ).run(MATCH, VICTIM);

      const payload = {
        round_numbers: [3],
        victims: [{ puuid: VICTIM, name: 'Danya', tag: 'UA1', agent: 'Sage' }],
      };
      sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('teamkill', ?, ?, ?, ?, 'posted')`,
      ).run(KILLER, MATCH, JSON.stringify(payload), Date.now() - 1000);

      const bot = { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } };
      const handler = makeTestRuntimeEventsHandler({ db, bot: bot as never });
      const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/test_runtime_events 2' } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(ctx as any, async () => {});

      // What PRODUCTION would post: the same renderTemplate fed by the same
      // shared resolver the publisher loop uses.
      const expected = renderTemplate(
        'teamkill',
        payload,
        { riot_name: 'Killer', riot_tag: 'KKK', telegram_id: 1, riot_puuid: KILLER },
        await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, payload),
      );

      const texts = bot.api.sendMessage.mock.calls.map((c) => c[1] as string);
      expect(texts).toContain(expected);

      // Guard against a vacuous pass: the expected render must actually carry
      // the roster-enriched data and the blank-line-separated layout
      // (title / '' / body / '' / link).
      expect(expected).toContain('<b>Danya#UA1</b>');
      expect(expected).toContain('<tg-emoji'); // rank/agent icons resolved
      expect(expected.split('\n')).toHaveLength(5);
    } finally {
      sqlite.close();
    }
  }, 15_000);
});

describe('collapseGroupableEvents', () => {
  const baseEv = { payload_json: '{}', detected_at: 0 } as const;

  it('groups every match_comeback row of one match into a single message', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'b', match_id: 'm1', detected_at: 110 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'c', match_id: 'm1', detected_at: 120 },
    ];
    const out = collapseGroupableEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.primary.riot_puuid).toBe('a');
    // Siblings are kept (the message names them), not dropped.
    expect(out[0]!.members.map((m) => m.riot_puuid)).toEqual(['a', 'b', 'c']);
  });

  it('groups EVERY realtime type per match, not just match_comeback', () => {
    for (const eventType of ['giant_slayer', 'teamkill', 'return_after_pause', 'community_clash']) {
      const events = [
        { ...baseEv, event_type: eventType, riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
        { ...baseEv, event_type: eventType, riot_puuid: 'b', match_id: 'm1', detected_at: 110 },
      ];
      const out = collapseGroupableEvents(events);
      expect(out, eventType).toHaveLength(1);
      expect(out[0]!.members, eventType).toHaveLength(2);
    }
  });

  it('does not collapse match_comeback across different matches', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm2', detected_at: 110 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(2);
  });

  it('does not collapse weekly event types (they never post to chat)', () => {
    const events = [
      { ...baseEv, event_type: 'ace', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'ace', riot_puuid: 'b', match_id: 'm1', detected_at: 110 },
      { ...baseEv, event_type: 'teamkill', riot_puuid: 'a', match_id: 'm1', detected_at: 120 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(3);
  });

  it('passes through groupable rows with null match_id (defensive)', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: null, detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'b', match_id: null, detected_at: 110 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(2);
  });
});
