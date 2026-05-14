import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import {
  findMissedAces,
  makePostMissedAcesHandler,
  _clearMissedAcesPreviewsForTest,
} from './missed-aces-command.ts';
import { OWNER_TELEGRAM_ID } from './test-commands.ts';

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

function seedUser(sqlite: Database.Database, puuid: string, name: string, tag: string) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(Math.floor(Math.random() * 1_000_000_000), puuid, name, tag, Date.now());
}

function seedMatch(
  sqlite: Database.Database,
  opts: {
    puuid: string;
    matchId: string;
    startedAt: number;
    map?: string;
    agent?: string;
    killEventsCompact: unknown[];
    roundsCompact: unknown[];
  },
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO match_records
       (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact, rounds_compact)
       VALUES (?, ?, ?, ?, ?, 15, 10, 0, 'win', 20, ?, ?)`,
    )
    .run(
      opts.puuid,
      opts.matchId,
      opts.startedAt,
      opts.map ?? 'Breeze',
      opts.agent ?? 'Jett',
      JSON.stringify(opts.killEventsCompact),
      JSON.stringify(opts.roundsCompact),
    );
}

function makeAceRoundKills(round: number, attacker: string) {
  return [
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: attacker, victim_puuid: 'e1' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: attacker, victim_puuid: 'e2' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: attacker, victim_puuid: 'e3' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: attacker, victim_puuid: 'e4' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: attacker, victim_puuid: 'e5' },
  ];
}

const NOW = 1_746_000_000_000;
const WIN_END = NOW;
const WIN_START = WIN_END - 24 * 3600 * 1000;
const IN_WINDOW = WIN_START + 3600 * 1000;
const OUT_OF_WINDOW = WIN_START - 3600 * 1000;

describe('findMissedAces', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('finds a player whose match has 5+ kills in a round but no detected_events row', async () => {
    seedUser(sqlite, 'p1', 'AcePlayer', 'AP');
    seedMatch(sqlite, {
      puuid: 'p1',
      matchId: 'm1',
      startedAt: IN_WINDOW,
      killEventsCompact: makeAceRoundKills(3, 'p1'),
      roundsCompact: [{ r: 3, w: 'Red' }], // p1 is Blue → lost
    });

    const lines = await findMissedAces(db, WIN_START, WIN_END);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.riotName).toBe('AcePlayer');
    expect(lines[0]!.rounds).toEqual([3]);
    expect(lines[0]!.roundsWon).toEqual([]); // round lost
  });

  it('excludes players whose ace event is already in detected_events', async () => {
    seedUser(sqlite, 'p1', 'AlreadyKnown', 'AK');
    seedMatch(sqlite, {
      puuid: 'p1',
      matchId: 'known-match',
      startedAt: IN_WINDOW,
      killEventsCompact: makeAceRoundKills(2, 'p1'),
      roundsCompact: [{ r: 2, w: 'Blue' }],
    });
    sqlite.prepare(
      `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
       VALUES ('ace', 'p1', 'known-match', '{}', ?, 'posted')`,
    ).run(IN_WINDOW);

    const lines = await findMissedAces(db, WIN_START, WIN_END);
    expect(lines).toHaveLength(0);
  });

  it('excludes matches outside the window', async () => {
    seedUser(sqlite, 'p1', 'OldAcer', 'OA');
    seedMatch(sqlite, {
      puuid: 'p1',
      matchId: 'm-old',
      startedAt: OUT_OF_WINDOW,
      killEventsCompact: makeAceRoundKills(3, 'p1'),
      roundsCompact: [{ r: 3, w: 'Blue' }],
    });

    const lines = await findMissedAces(db, WIN_START, WIN_END);
    expect(lines).toHaveLength(0);
  });

  it('does not include matches with fewer than 5 enemy kills (no ace)', async () => {
    seedUser(sqlite, 'p1', 'NoAcer', 'NA');
    const fourKills = makeAceRoundKills(1, 'p1').slice(0, 4);
    seedMatch(sqlite, {
      puuid: 'p1',
      matchId: 'm-4k',
      startedAt: IN_WINDOW,
      killEventsCompact: fourKills,
      roundsCompact: [{ r: 1, w: 'Blue' }],
    });

    const lines = await findMissedAces(db, WIN_START, WIN_END);
    expect(lines).toHaveLength(0);
  });
});

describe('makePostMissedAcesHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    _clearMissedAcesPreviewsForTest();
  });

  afterEach(() => {
    sqlite.close();
  });

  function makeMockBot() {
    return { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } };
  }

  it('non-owner is silently ignored', async () => {
    const bot = makeMockBot();
    const handler = makePostMissedAcesHandler({ db, bot: bot as never, getPrimaryChatId: () => 1 });
    const ctx = { from: { id: 12345 }, message: { text: '/post_missed_aces 1' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('daysBack=0 (default) rejects with a usage hint', async () => {
    const bot = makeMockBot();
    const handler = makePostMissedAcesHandler({ db, bot: bot as never, getPrimaryChatId: () => 1 });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/post_missed_aces' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = bot.api.sendMessage.mock.calls[0]!;
    expect(text).toContain('N≥1');
  });
});
