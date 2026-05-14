import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { buildDailyAceDigest } from './build.ts';

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

  describe('zero aces in window', () => {
    it('returns { text: null, includedEventIds: [] } when no aces exist', async () => {
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });

    it('returns { text: null, includedEventIds: [] } when aces exist but all outside window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PlayerOne', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'old-match', startedAt: OUT_OF_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'old-match', detectedAt: OUT_OF_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.includedEventIds).toEqual([]);
    });
  });

  describe('single ace, one player', () => {
    it('renders header, legend, and one line with round-won emoji', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AcePlayer', riotTag: 'ACE' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, map: 'Ascent', agent: 'Omen' });
      const id = seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm1',
        detectedAt: IN_WINDOW,
        rounds: [1], // 0-indexed → displayed as "round 2"
        roundsWon: [1],
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      expect(result.includedEventIds).toEqual([id]);

      const text = result.text!;
      expect(text).toContain('🎯 Ace');
      expect(text).toContain('💀 без победы в раунде');
      expect(text).toContain('🏆 с победой в раунде');
      expect(text).toContain('<b>AcePlayer#ACE</b>');
      expect(text).toContain('(Omen)');
      expect(text).toContain('🏆round 2');
      expect(text).toContain('🗺');
      expect(text).toContain('tracker.gg/valorant/match/m1');
      expect(text).toContain('>Ascent</a>');
    });

    it('uses 💀 when the ace round was lost', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'LostAcer', riotTag: 'L' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, map: 'Breeze', agent: 'Jett' });
      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm1',
        detectedAt: IN_WINDOW,
        rounds: [7],
        roundsWon: [], // round was lost
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('💀round 8');
      expect(text).not.toContain('🏆round 8');
    });
  });

  describe('chronological order across players', () => {
    it('lines are sorted by detected_at ascending (earliest first), no player grouping', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'EarlyBird', riotTag: 'EB' });
      seedUser(sqlite, 2, 'p2', { riotName: 'LateBird', riotTag: 'LB' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'p1m1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'p2m1', startedAt: IN_WINDOW + 2000 });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'p1m2', startedAt: IN_WINDOW + 4000 });

      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'p1m1', detectedAt: IN_WINDOW, rounds: [0], roundsWon: [0] });
      seedAceEvent(sqlite, { puuid: 'p2', matchId: 'p2m1', detectedAt: IN_WINDOW + 2000, rounds: [3], roundsWon: [3] });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'p1m2', detectedAt: IN_WINDOW + 4000, rounds: [5], roundsWon: [] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;

      const posEarly = text.indexOf('EarlyBird#EB');
      const posLate = text.indexOf('LateBird#LB');
      const posEarlySecond = text.lastIndexOf('EarlyBird#EB');
      // First EarlyBird line comes before LateBird line; second EarlyBird comes after.
      expect(posEarly).toBeLessThan(posLate);
      expect(posLate).toBeLessThan(posEarlySecond);
    });
  });

  describe('multiple aces in same match', () => {
    it('renders xN with per-round emojis in parentheses', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'MultiAce', riotTag: 'MA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mx', startedAt: IN_WINDOW, map: 'Lotus', agent: 'Jett' });

      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'mx',
        detectedAt: IN_WINDOW,
        rounds: [0, 11], // displayed as 1 and 12
        roundsWon: [11], // round 1 lost, round 12 won
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('x2 (💀round 1, 🏆round 12)');
      expect(text).toContain('Lotus');
    });

    it('sorts rounds ascending inside the parentheses regardless of payload order', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Z', riotTag: 'Z' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm', startedAt: IN_WINDOW, map: 'Haven' });
      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm',
        detectedAt: IN_WINDOW,
        rounds: [11, 0, 5], // out of order
        roundsWon: [0, 5, 11],
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('x3 (🏆round 1, 🏆round 6, 🏆round 12)');
    });
  });

  describe('knife_kill events (combined section)', () => {
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

    it('renders knife section under 🔪 Заколол баранчика with same line format', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Knifer', riotTag: 'K1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'kn-match', startedAt: IN_WINDOW, map: 'Bind', agent: 'Reyna' });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'kn-match', detectedAt: IN_WINDOW, rounds: [4], roundsWon: [4] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('🔪 Заколол баранчика');
      expect(text).toContain('<b>Knifer#K1</b> (Reyna) 🏆round 5 · 🗺<a');
      expect(text).toContain('Эйсы и ножи за предыдущие 24 часа');
    });

    it('combines ace + knife sections in one post (chronology within each)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Mixed', riotTag: 'MX' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mix-ace', startedAt: IN_WINDOW, map: 'Lotus', agent: 'Jett' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mix-kn', startedAt: IN_WINDOW + 1000, map: 'Bind', agent: 'Reyna' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'mix-ace', detectedAt: IN_WINDOW, rounds: [3], roundsWon: [3] });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'mix-kn', detectedAt: IN_WINDOW + 1000, rounds: [7], roundsWon: [] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      // Order: Ace header → ace line → knife header → knife line → footer
      const aceHeaderPos = text.indexOf('🎯 Ace');
      const aceLinePos = text.indexOf('Lotus');
      const knifeHeaderPos = text.indexOf('🔪 Заколол баранчика');
      const knifeLinePos = text.indexOf('Bind');
      const footerPos = text.indexOf('Эйсы и ножи');
      expect(aceHeaderPos).toBeLessThan(aceLinePos);
      expect(aceLinePos).toBeLessThan(knifeHeaderPos);
      expect(knifeHeaderPos).toBeLessThan(knifeLinePos);
      expect(knifeLinePos).toBeLessThan(footerPos);
    });

    it('omits knife section entirely when no knife events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AceOnly', riotTag: 'AO' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'a1', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'a1', detectedAt: IN_WINDOW, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).not.toContain('🔪');
      expect(text).toContain('🎯 Ace');
      expect(text).toContain('Эйсы и ножи за предыдущие 24 часа');
    });

    it('dedupes rounds when 2 knife kills in the same round', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'DoubleKnife', riotTag: 'DK' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'dk', startedAt: IN_WINDOW, map: 'Split', agent: 'Sage' });
      // Detector emits rounds=[5,5] when there are 2 knife kills in round 5.
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'dk', detectedAt: IN_WINDOW, rounds: [5, 5], roundsWon: [5] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      // Should NOT show 'x2 (🏆round 6, 🏆round 6)' — dedup keeps one round.
      expect(text).toContain('🏆round 6');
      expect(text).not.toContain('x2');
    });
  });

  describe('legacy payload without rounds_won field', () => {
    it('renders round number without 💀/🏆 emoji when no match_records data', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Legacy', riotTag: 'L' });
      // No match_records row → cannot derive won/lost.
      sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('ace', 'p1', 'leg', ?, ?, 'silent')`,
      ).run(JSON.stringify({ rounds: [4], weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']] }), IN_WINDOW);

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('round 5');
      expect(text).not.toContain('💀round 5');
      expect(text).not.toContain('🏆round 5');
    });

    it('derives 🏆/💀 from match_records.rounds_compact + kill_events_compact when payload lacks rounds_won', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Legacy', riotTag: 'L' });
      // Seed a match_record with rounds_compact and kill_events_compact so the
      // builder can derive whether the player's team won round 4.
      const killEvents = [
        { round: 4, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: 'p1', victim_puuid: 'e1' },
      ];
      const roundsCompact = [
        { r: 4, w: 'Blue' }, // p1 is Blue → won round 4
        { r: 7, w: 'Red' }, // p1 is Blue → lost round 7
      ];
      sqlite.prepare(
        `INSERT INTO match_records
         (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact, rounds_compact)
         VALUES ('p1', 'derive-match', ?, 'Bind', 'Sage', 5, 5, 5, 'win', 21, ?, ?)`,
      ).run(IN_WINDOW, JSON.stringify(killEvents), JSON.stringify(roundsCompact));

      // Legacy payload has rounds but no rounds_won.
      sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('ace', 'p1', 'derive-match', ?, ?, 'silent')`,
      ).run(JSON.stringify({ rounds: [4, 7], weapons_per_round: [['Vandal'], ['Vandal']] }), IN_WINDOW);

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('x2 (🏆round 5, 💀round 8)');
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
});
