import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { buildAceKnifeStandings } from './ace-knife.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function seedUser(
  sqlite: Database.Database,
  id: number,
  puuid: string,
  name: string,
  tag = 'TAG',
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, puuid, name, tag, Date.now());
}

let eventSeq = 0;
function seedEvent(
  sqlite: Database.Database,
  opts: {
    puuid: string;
    eventType: 'ace' | 'knife_kill';
    payload: Record<string, unknown>;
    detectedAt: number;
    status?: string;
    matchId?: string;
  },
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO detected_events
       (event_type, riot_puuid, match_id, payload_json, detected_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.eventType,
      opts.puuid,
      opts.matchId ?? `m-${++eventSeq}`,
      JSON.stringify(opts.payload),
      opts.detectedAt,
      opts.status ?? 'digest-only',
    );
}

const WEEK_END = 1_746_000_000_000;
const WEEK_START = WEEK_END - 7 * 86400000;
const IN_WINDOW = WEEK_START + 86400000;
const OUT_OF_WINDOW = WEEK_START - 86400000;

const NO_OPT_OUTS = new Set<number>();

describe('buildAceKnifeStandings', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });
  afterEach(() => {
    sqlite.close();
  });

  it('returns empty boards when there are no events', async () => {
    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r).toEqual({ aces: [], knives: [] });
  });

  it('counts one ace per aced round, summed across a player’s matches', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    // Two ace events: 2 aced rounds in one match, 1 in another → 3 total.
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [3, 11] }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [7] }, detectedAt: IN_WINDOW + 1000 });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces).toEqual([{ name: 'Alpha', tag: 'AAA', count: 3 }]);
    expect(r.knives).toEqual([]);
  });

  it('counts one knife per KILL, so two knife kills in one round count as 2', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    // rounds repeats round 5 — two knife kills landed in it.
    seedEvent(sqlite, {
      puuid: 'p1',
      eventType: 'knife_kill',
      payload: { count: 3, rounds: [5, 5, 9], victims_afk: [false, false, false] },
      detectedAt: IN_WINDOW,
    });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.knives).toEqual([{ name: 'Alpha', tag: 'AAA', count: 3 }]);
  });

  it('ignores victims_afk on legacy rows — AFK kills count the same as any other', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedUser(sqlite, 2, 'p2', 'Beta', 'BBB');
    // Historical rows still carry victims_afk; the goose split is retired, so
    // three knife kills are three knife kills regardless of the flags.
    seedEvent(sqlite, {
      puuid: 'p1',
      eventType: 'knife_kill',
      payload: { count: 3, rounds: [1, 2, 3], victims_afk: [true, false, true] },
      detectedAt: IN_WINDOW,
    });
    seedEvent(sqlite, {
      puuid: 'p2',
      eventType: 'knife_kill',
      payload: { count: 3, rounds: [1, 2, 3] },
      detectedAt: IN_WINDOW,
    });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.knives).toEqual([
      { name: 'Alpha', tag: 'AAA', count: 3 },
      { name: 'Beta', tag: 'BBB', count: 3 },
    ]);
  });

  it('sorts desc by count, then by nick', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedUser(sqlite, 2, 'p2', 'Beta', 'BBB');
    seedUser(sqlite, 3, 'p3', 'Gamma', 'GGG');
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, { puuid: 'p2', eventType: 'ace', payload: { rounds: [1, 2, 3] }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, { puuid: 'p3', eventType: 'ace', payload: { rounds: [1, 2] }, detectedAt: IN_WINDOW });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces.map((a) => `${a.name}:${a.count}`)).toEqual(['Beta:3', 'Gamma:2', 'Alpha:1']);
  });

  it('breaks an exact tie by nick so the order is stable across runs', async () => {
    seedUser(sqlite, 1, 'p1', 'Zeta', 'ZZZ');
    seedUser(sqlite, 2, 'p2', 'Alpha', 'AAA');
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, { puuid: 'p2', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW + 1 });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces.map((a) => a.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('respects the window — events outside [start, end) are ignored', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: OUT_OF_WINDOW });
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [2] }, detectedAt: WEEK_END });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces).toEqual([]);
  });

  it('counts events of ANY status — historical rows from the daily-digest era still count', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    for (const status of ['posted', 'silent', 'digest-only', 'pending']) {
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'ace',
        payload: { rounds: [1] },
        detectedAt: IN_WINDOW,
        status,
      });
    }
    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces[0]?.count).toBe(4);
  });

  it('drops opted-out players from both boards', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedUser(sqlite, 2, 'p2', 'Beta', 'BBB');
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, {
      puuid: 'p1',
      eventType: 'knife_kill',
      payload: { count: 1, rounds: [1], victims_afk: [false] },
      detectedAt: IN_WINDOW,
    });
    seedEvent(sqlite, { puuid: 'p2', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, new Set([1]));
    expect(r.aces).toEqual([{ name: 'Beta', tag: 'BBB', count: 1 }]);
    expect(r.knives).toEqual([]);
  });

  it('drops events whose puuid has no users row (no nick to render)', async () => {
    seedEvent(sqlite, { puuid: 'ghost', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });
    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces).toEqual([]);
  });

  it('falls back to the scalar counters on legacy rows with no rounds array', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    seedUser(sqlite, 2, 'p2', 'Beta', 'BBB');
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { total_aces: 2 }, detectedAt: IN_WINDOW });
    seedEvent(sqlite, { puuid: 'p2', eventType: 'knife_kill', payload: { count: 5 }, detectedAt: IN_WINDOW });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces[0]?.count).toBe(2);
    expect(r.knives[0]?.count).toBe(5);
  });

  it('survives malformed payload json without throwing', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    sqlite
      .prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('ace', 'p1', 'bad-json', '{not json', ?, 'digest-only')`,
      )
      .run(IN_WINDOW);
    seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces).toEqual([{ name: 'Alpha', tag: 'AAA', count: 1 }]);
  });

  it('ignores other event types entirely', async () => {
    seedUser(sqlite, 1, 'p1', 'Alpha', 'AAA');
    sqlite
      .prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('teamkill', 'p1', 'tk-1', '{"rounds":[1,2,3]}', ?, 'posted')`,
      )
      .run(IN_WINDOW);

    const r = await buildAceKnifeStandings(db, WEEK_START, WEEK_END, NO_OPT_OUTS);
    expect(r.aces).toEqual([]);
    expect(r.knives).toEqual([]);
  });
});
