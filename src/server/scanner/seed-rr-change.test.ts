import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { seedRrChange } from './seed-rr-change.ts';
import type { HenrikMmrHistoryEntry } from '../lib/henrik.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('seedRrChange', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedUser(id: number, puuid: string, region: string | null = 'eu') {
    sqlite
      .prepare(
        `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, riot_region, joined_at)
         VALUES (?, ?, ?, 'TAG', ?, ?)`,
      )
      .run(id, puuid, `Player${id}`, region, Date.now());
  }

  function seedMatch(puuid: string, matchId: string, rr: { rrChange?: number | null; rankBefore?: string | null } = {}) {
    sqlite
      .prepare(
        `INSERT INTO match_records
         (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played,
          kill_events_compact, rr_change, rank_before)
         VALUES (?, ?, ?, 'Ascent', 'Jett', 15, 10, 3, 'win', 20, '[]', ?, ?)`,
      )
      .run(puuid, matchId, Date.now(), rr.rrChange ?? null, rr.rankBefore ?? null);
  }

  function rowOf(puuid: string, matchId: string) {
    return sqlite
      .prepare('SELECT rr_change, rank_before FROM match_records WHERE riot_puuid = ? AND match_id = ?')
      .get(puuid, matchId) as { rr_change: number | null; rank_before: string | null };
  }

  const entry = (
    matchId: string,
    lastChange: number | null,
    tierBefore: string | null = 'Diamond 3',
  ): HenrikMmrHistoryEntry => ({
    match_id: matchId,
    last_change: lastChange,
    tier_before_update: tierBefore ? { id: 20, name: tierBefore } : null,
  });

  const quiet = () => {};

  it('fills rr_change + rank_before on null rows only, matched by (match_id, puuid)', async () => {
    seedUser(1, 'p-a');
    seedUser(2, 'p-b');
    seedMatch('p-a', 'm-1');
    seedMatch('p-a', 'm-2', { rrChange: 7, rankBefore: 'Ascendant 1' }); // scanner already wrote it
    // The same lobby recorded for a friend — p-a's history must not touch p-b's row.
    seedMatch('p-b', 'm-1');

    const histories: Record<string, HenrikMmrHistoryEntry[]> = {
      'p-a': [entry('m-1', -18, 'Ascendant 1'), entry('m-2', 99, 'Iron 1'), entry('m-unknown', 12)],
      'p-b': [],
    };
    const result = await seedRrChange(db, {
      fetchHistory: async (puuid) => histories[puuid]!,
      apply: true,
      log: quiet,
      pauseMs: 0,
    });

    expect(rowOf('p-a', 'm-1')).toEqual({ rr_change: -18, rank_before: 'Ascendant 1' });
    // Scanner's value wins.
    expect(rowOf('p-a', 'm-2')).toEqual({ rr_change: 7, rank_before: 'Ascendant 1' });
    expect(rowOf('p-b', 'm-1')).toEqual({ rr_change: null, rank_before: null });
    expect(result).toEqual({ users: 2, candidates: 1, updated: 1, skipped: 0 });
  });

  it('skips entries Henrik has no verdict for, and keeps a stored rank_before when the tier is missing', async () => {
    seedUser(1, 'p-a');
    seedMatch('p-a', 'm-null');
    seedMatch('p-a', 'm-notier', { rankBefore: 'Gold 2' });

    await seedRrChange(db, {
      fetchHistory: async () => [entry('m-null', null), entry('m-notier', 14, null)],
      apply: true,
      log: quiet,
      pauseMs: 0,
    });

    expect(rowOf('p-a', 'm-null')).toEqual({ rr_change: null, rank_before: null });
    expect(rowOf('p-a', 'm-notier')).toEqual({ rr_change: 14, rank_before: 'Gold 2' });
  });

  it('dry-run counts the candidates and writes nothing', async () => {
    seedUser(1, 'p-a');
    seedMatch('p-a', 'm-1');
    seedMatch('p-a', 'm-2');

    const result = await seedRrChange(db, {
      fetchHistory: async () => [entry('m-1', 20), entry('m-2', -5)],
      apply: false,
      log: quiet,
      pauseMs: 0,
    });

    expect(result).toEqual({ users: 1, candidates: 2, updated: 0, skipped: 0 });
    expect(rowOf('p-a', 'm-1').rr_change).toBeNull();
    expect(rowOf('p-a', 'm-2').rr_change).toBeNull();
  });

  it('a failing member is logged and skipped — the others still get seeded', async () => {
    seedUser(1, 'p-broken');
    seedUser(2, 'p-ok');
    seedMatch('p-ok', 'm-1');
    const lines: string[] = [];

    const result = await seedRrChange(db, {
      fetchHistory: async (puuid) => {
        if (puuid === 'p-broken') throw new Error('Henrik 503');
        return [entry('m-1', 21)];
      },
      apply: true,
      log: (line) => lines.push(line),
      pauseMs: 0,
    });

    expect(result).toEqual({ users: 2, candidates: 1, updated: 1, skipped: 1 });
    expect(rowOf('p-ok', 'm-1').rr_change).toBe(21);
    expect(lines.some((l) => l.includes('Player1#TAG') && l.includes('SKIPPED') && l.includes('Henrik 503'))).toBe(true);
  });

  it('only asks about members with both a PUUID and a region, passing the region through', async () => {
    seedUser(1, 'p-eu', 'eu');
    seedUser(2, 'p-noregion', null);
    const calls: Array<[string, string]> = [];

    const result = await seedRrChange(db, {
      fetchHistory: async (puuid, region) => {
        calls.push([puuid, region]);
        return [];
      },
      apply: true,
      log: quiet,
      pauseMs: 0,
    });

    expect(calls).toEqual([['p-eu', 'eu']]);
    expect(result.users).toBe(1);
  });

  it('a second run is a no-op', async () => {
    seedUser(1, 'p-a');
    seedMatch('p-a', 'm-1');
    const opts = {
      fetchHistory: async () => [entry('m-1', 30)],
      apply: true,
      log: quiet,
      pauseMs: 0,
    };

    expect((await seedRrChange(db, opts)).updated).toBe(1);
    expect((await seedRrChange(db, opts)).updated).toBe(0);
    expect(rowOf('p-a', 'm-1').rr_change).toBe(30);
  });
});
