import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { buildDailyAceDigest } from './build.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from '../publisher/valorant-emoji.ts';
import { renderPlayerName } from '../publisher/player-render.ts';

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

// ─── Seed helpers ────────────────────────────────────────────────────────────

function seedUser(
  sqlite: Database.Database,
  id: number,
  puuid: string,
  opts: { riotName?: string; riotTag?: string } = {},
) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, puuid, opts.riotName ?? `Player${id}`, opts.riotTag ?? 'TAG', Date.now());
}

interface MatchOpts {
  puuid: string;
  matchId?: string;
  startedAt?: number;
  map?: string;
  agent?: string;
}

function seedMatch(sqlite: Database.Database, opts: MatchOpts) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO match_records
       (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
       VALUES (?, ?, ?, ?, ?, 15, 10, 0, 'win', 20, '[]')`,
    )
    .run(
      opts.puuid,
      opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
      opts.startedAt ?? Date.now(),
      opts.map ?? 'Ascent',
      opts.agent ?? 'Jett',
    );
}

interface AceEventOpts {
  puuid: string;
  matchId: string;
  detectedAt?: number;
  status?: string;
  rounds?: number[]; // 0-indexed
  roundsWon?: number[]; // subset of rounds
  weaponsPerRound?: unknown[][];
}

function seedAceEvent(sqlite: Database.Database, opts: AceEventOpts): number {
  const rounds = opts.rounds ?? [0];
  const payload: Record<string, unknown> = {
    rounds,
    rounds_won: opts.roundsWon ?? [],
    weapons_per_round:
      opts.weaponsPerRound ?? rounds.map(() => ['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']),
  };
  const result = sqlite
    .prepare(
      `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
       VALUES ('ace', ?, ?, ?, ?, ?)`,
    )
    .run(opts.puuid, opts.matchId, JSON.stringify(payload), opts.detectedAt ?? Date.now(), opts.status ?? 'silent');
  return result.lastInsertRowid as number;
}

function seedKnifeEvent(
  sqlite: Database.Database,
  opts: { puuid: string; matchId: string; detectedAt: number; rounds: number[]; roundsWon: number[] },
): number {
  const payload = {
    count: opts.rounds.length,
    rounds: opts.rounds,
    rounds_won: opts.roundsWon,
  };
  const result = sqlite.prepare(
    `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
     VALUES ('knife_kill', ?, ?, ?, ?, 'silent')`,
  ).run(opts.puuid, opts.matchId, JSON.stringify(payload), opts.detectedAt);
  return result.lastInsertRowid as number;
}

// ─── Test window constants ────────────────────────────────────────────────────

const NOW = 1_746_000_000_000;
const WIN_END = NOW;
const WIN_START = WIN_END - 24 * 3600 * 1000;
const IN_WINDOW = WIN_START + 3600 * 1000;
const OUT_OF_WINDOW = WIN_START - 3600 * 1000;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildDailyAceDigest', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('zero events in window', () => {
    it('returns { text: null, includedEventIds: [] } when no events exist', async () => {
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });

    it('returns { text: null, includedEventIds: [] } when events exist but all outside window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PlayerOne', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'old-match', startedAt: OUT_OF_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'old-match', detectedAt: OUT_OF_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });
  });

  describe('excludeEventIds filtering', () => {
    it('skips events whose IDs are in excludeEventIds', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'FilteredPlayer', riotTag: 'FP' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'excl-match', startedAt: IN_WINDOW });
      const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'excl-match', detectedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({
        db,
        windowStart: WIN_START,
        windowEnd: WIN_END,
        excludeEventIds: [id],
      });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });

    it('includes events NOT in excludeEventIds', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'incl-match', startedAt: IN_WINDOW });
      const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'incl-match', detectedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({
        db,
        windowStart: WIN_START,
        windowEnd: WIN_END,
        excludeEventIds: [99999],
      });
      expect(result.text).not.toBeNull();
      expect(result.includedEventIds).toContain(id);
    });
  });

  describe('status filtering', () => {
    it('includes events with status=silent', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SilentAce', riotTag: 'SA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'si-match', startedAt: IN_WINDOW });
      const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'si-match', detectedAt: IN_WINDOW, status: 'silent' });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.includedEventIds).toContain(id);
    });

    it('includes events with status=digest-only', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'DigestAce', riotTag: 'DA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'do-match', startedAt: IN_WINDOW });
      const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'do-match', detectedAt: IN_WINDOW, status: 'digest-only' });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.includedEventIds).toContain(id);
    });

    it('does NOT include events with status=posted', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PostedAce', riotTag: 'PA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'po-match', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'po-match', detectedAt: IN_WINDOW, status: 'posted' });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });

    it('does NOT include events with status=failed', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'FailedAce', riotTag: 'FA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'fa-match', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'fa-match', detectedAt: IN_WINDOW, status: 'failed' });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });

    it('does NOT include events with status=pending', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PendingAce', riotTag: 'PEA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'pe-match', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'pe-match', detectedAt: IN_WINDOW, status: 'pending' });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });
  });

  it('renders the exact plain headings and a rank/name plus linked match icons per ace', async () => {
    seedUser(sqlite, 1, 'p1', { riotName: 'Ace', riotTag: 'ACE' });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
    sqlite.prepare("UPDATE match_records SET rank_before = NULL, rank_after = 'Diamond 3'").run();
    const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW });
    const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(result).toEqual({
      text: '🍿 Эйсы и ножи за предыдущие 24 часа\n\n🎯 Эйсы\n\n- ' +
        renderPlayerName({ name: 'Ace', tag: 'ACE', isCommunity: true, rank: 'Diamond 3' }) +
        ` <a href="https://tracker.gg/valorant/match/m1">${agentToEmojiHtml('Jett')}/${mapToEmojiHtml('Ascent')}</a>`,
      includedEventIds: [id],
    });
  });

  it('keeps each player contiguous across matches and sorts groups by occurrence count, then first detection', async () => {
    for (const [id, name] of [[1, 'First'], [2, 'Busy'], [3, 'Last']] as const) {
      seedUser(sqlite, id, `p${id}`, { riotName: name, riotTag: 'T' });
    }
    const events = [
      { puuid: 'p1', matchId: 'first', rounds: [0] },
      { puuid: 'p2', matchId: 'busy-1', rounds: [0] },
      { puuid: 'p3', matchId: 'last', rounds: [0] },
      { puuid: 'p2', matchId: 'busy-2', rounds: [3, 8] },
    ];
    for (const [i, event] of events.entries()) {
      seedMatch(sqlite, { ...event, agent: i === 3 ? 'Omen' : 'Jett', map: i === 3 ? 'Bind' : 'Ascent' });
      seedAceEvent(sqlite, { ...event, detectedAt: IN_WINDOW + i });
    }
    const { text } = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect([...text!.matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1])).toEqual([
      'Busy#T', 'Busy#T', 'Busy#T', 'First#T', 'Last#T',
    ]);
    expect([...text!.matchAll(/href="https:\/\/tracker.gg\/valorant\/match\/([^"]+)"/g)].map((m) => m[1])).toEqual([
      'busy-1', 'busy-2', 'busy-2', 'first', 'last',
    ]);
    expect(text!.match(new RegExp(agentToEmojiHtml('Omen'), 'g'))).toHaveLength(2);
    expect(text).not.toContain('×');
  });

  it('renders one row per ace round and per knife kill, with aces first even when knives were detected first', async () => {
    seedUser(sqlite, 1, 'p1', { riotName: 'Both', riotTag: 'T' });
    seedMatch(sqlite, { puuid: 'p1', matchId: 'm1' });
    const knife = seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW, rounds: [5, 5], roundsWon: [] });
    const ace = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW + 1, rounds: [0, 3] });
    const { text, includedEventIds } = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    const row = `- <b>Both#T</b> <a href="https://tracker.gg/valorant/match/m1">${agentToEmojiHtml('Jett')}/${mapToEmojiHtml('Ascent')}</a>`;
    expect(text).toBe(`🍿 Эйсы и ножи за предыдущие 24 часа\n\n🎯 Эйсы\n\n${row}\n${row}\n\n🔪 Ножи\n\n${row}\n${row}`);
    expect(includedEventIds).toEqual([knife, ace]);
  });

  it('groups by PUUID even when two players have identical display names', async () => {
    seedUser(sqlite, 1, 'p1', { riotName: 'Same', riotTag: 'T' });
    seedUser(sqlite, 2, 'p2', { riotName: 'Same', riotTag: 'T' });
    seedUser(sqlite, 3, 'p3', { riotName: 'Middle', riotTag: 'T' });
    for (const [i, puuid] of ['p1', 'p3', 'p2'].entries()) {
      seedAceEvent(sqlite, { puuid, matchId: puuid, detectedAt: IN_WINDOW + i });
    }
    const { text } = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect([...text!.matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1])).toEqual(['Same#T', 'Middle#T', 'Same#T']);
  });

  it('keeps a clickable fallback for missing match data and escapes the nick and link', async () => {
    seedUser(sqlite, 1, 'p1', { riotName: '<Ace&>', riotTag: '"T' });
    seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'm"&', detectedAt: IN_WINDOW, rounds: [2], roundsWon: [] });
    const { text } = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(text).toBe('🍿 Эйсы и ножи за предыдущие 24 часа\n\n🔪 Ножи\n\n- <b>&lt;Ace&amp;&gt;#&quot;T</b> <a href="https://tracker.gg/valorant/match/m&quot;&amp;">🦸/⛰️</a>');
  });

  it('omits unknown ranks and uses linked fallback icons for unknown agents and maps', async () => {
    seedUser(sqlite, 1, 'p1');
    seedMatch(sqlite, { puuid: 'p1', matchId: 'unknown', agent: 'Future agent', map: 'Future map' });
    sqlite.prepare("UPDATE match_records SET rank_after = 'Future rank'").run();
    seedAceEvent(sqlite, { puuid: 'p1', matchId: 'unknown', detectedAt: IN_WINDOW });
    const { text } = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(text).toContain('- <b>Player1#TAG</b> <a href="https://tracker.gg/valorant/match/unknown">🦸/⛰️</a>');
    expect(text).not.toContain('Future');
  });

  it('includes the window start, excludes the window end and other event types', async () => {
    seedUser(sqlite, 1, 'p1');
    const start = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'start', detectedAt: WIN_START });
    seedAceEvent(sqlite, { puuid: 'p1', matchId: 'end', detectedAt: WIN_END });
    const other = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'other', detectedAt: IN_WINDOW });
    sqlite.prepare("UPDATE detected_events SET event_type = 'clutch' WHERE id = ?").run(other);
    const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(result.includedEventIds).toEqual([start]);
  });

  it('does not acknowledge malformed or empty events as included in the rendered digest', async () => {
    seedUser(sqlite, 1, 'p1');
    const empty = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'empty', detectedAt: IN_WINDOW, rounds: [] });
    const malformed = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'bad', detectedAt: IN_WINDOW });
    sqlite.prepare('UPDATE detected_events SET payload_json = ? WHERE id = ?').run('{bad', malformed);
    expect(await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END })).toEqual({ text: null, includedEventIds: [] });
    const valid = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'valid', detectedAt: IN_WINDOW });
    const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(result.includedEventIds).toEqual([valid]);
    expect(result.includedEventIds).not.toContain(empty);
  });

  it('renders legacy scalar occurrence counts when the rounds array is absent', async () => {
    seedUser(sqlite, 1, 'p1');
    const id = seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'legacy', detectedAt: IN_WINDOW, rounds: [], roundsWon: [] });
    sqlite.prepare('UPDATE detected_events SET payload_json = ? WHERE id = ?').run('{"count":2}', id);
    const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
    expect(result.text!.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(result.includedEventIds).toEqual([id]);
  });
});
