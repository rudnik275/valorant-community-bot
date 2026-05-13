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
}

function seedMatch(sqlite: Database.Database, opts: MatchOpts) {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO match_records
       (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
       VALUES (?, ?, ?, ?, 'Jett', 15, 10, 0, 'win', 20, '[]')`,
    )
    .run(
      opts.puuid,
      opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
      opts.startedAt ?? Date.now(),
      opts.map ?? 'Ascent',
    );
}

interface AceEventOpts {
  puuid: string;
  matchId: string;
  detectedAt?: number;
  status?: string;
  weaponsPerRound?: unknown[][];
}

function seedAceEvent(sqlite: Database.Database, opts: AceEventOpts): number {
  const payload = {
    weapons_per_round: opts.weaponsPerRound ?? [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']],
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

const NOW = 1_746_000_000_000; // arbitrary fixed point
const WIN_END = NOW;
const WIN_START = WIN_END - 24 * 3600 * 1000;
const IN_WINDOW = WIN_START + 3600 * 1000; // 1h into window
const OUT_OF_WINDOW = WIN_START - 3600 * 1000; // 1h before window start

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

  // ── Test 1: Zero aces in window ──────────────────────────────────────────────
  describe('zero aces in window', () => {
    it('returns { text: null, includedEventIds: [] } when no aces exist', async () => {
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      // No ace events seeded

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

  // ── Test 2: Single ace, one player ──────────────────────────────────────────
  describe('single ace, one player', () => {
    it('renders header + one section + one bullet', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AcePlayer', riotTag: 'ACE' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, map: 'Ascent' });
      const id = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      expect(result.includedEventIds).toEqual([id]);

      const text = result.text!;
      // Header
      expect(text).toContain('🎯');
      expect(text).toContain('Ейсы за сутки');
      // Player section
      expect(text).toContain('AcePlayer#ACE');
      expect(text).toContain('(1)');
      // Bullet with map
      expect(text).toContain('Ascent');
      // Match link
      expect(text).toContain('матч');
      expect(text).toContain('tracker.gg/valorant/match/m1');
    });
  });

  // ── Test 3: Two players, three aces ─────────────────────────────────────────
  describe('two players, three aces', () => {
    it('groups by player and sorts by ace count desc', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'TopAcer', riotTag: 'TOP' });
      seedUser(sqlite, 2, 'p2', { riotName: 'OneAce', riotTag: 'ONE' });

      // p1 gets 2 aces in different matches
      seedMatch(sqlite, { puuid: 'p1', matchId: 'p1m1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'p1m2', startedAt: IN_WINDOW + 1000 });
      const id1 = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'p1m1', detectedAt: IN_WINDOW });
      const id2 = seedAceEvent(sqlite, { puuid: 'p1', matchId: 'p1m2', detectedAt: IN_WINDOW + 1000 });

      // p2 gets 1 ace
      seedMatch(sqlite, { puuid: 'p2', matchId: 'p2m1', startedAt: IN_WINDOW + 2000 });
      const id3 = seedAceEvent(sqlite, { puuid: 'p2', matchId: 'p2m1', detectedAt: IN_WINDOW + 2000 });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      expect(result.includedEventIds).toHaveLength(3);
      expect(result.includedEventIds).toContain(id1);
      expect(result.includedEventIds).toContain(id2);
      expect(result.includedEventIds).toContain(id3);

      const text = result.text!;
      // TopAcer has 2 aces, OneAce has 1 — TopAcer should appear first
      const topPos = text.indexOf('TopAcer');
      const onePos = text.indexOf('OneAce');
      expect(topPos).toBeLessThan(onePos);

      // TopAcer has count (2), OneAce has count (1)
      expect(text).toContain('TopAcer#TOP</b> (2)');
      expect(text).toContain('OneAce#ONE</b> (1)');
    });
  });

  // ── Test 4: One player, two aces in same match ───────────────────────────────
  describe('one player, two aces in same match', () => {
    it('renders one bullet without ×M for a normal single-row ace', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'DoubleAce', riotTag: 'DBL' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'same-match', startedAt: IN_WINDOW, map: 'Bind' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'same-match', detectedAt: IN_WINDOW });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      expect(text).toContain('DoubleAce#DBL');
      expect(text).toContain('Bind');
      // Only one row → no ×M label
      expect(text).not.toContain('\xd72'); // ×2
    });

    it('shows ×2 when one row carries two aces (multi-round payload)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'MultiAce', riotTag: 'MA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mx', startedAt: IN_WINDOW, map: 'Haven' });

      // UNIQUE(match_id, event_type, riot_puuid) means a player can only have
      // one ace event row per match. Two aces in the same match are encoded
      // as two entries inside payload.weapons_per_round.
      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'mx',
        detectedAt: IN_WINDOW,
        weaponsPerRound: [
          ['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal'],
          ['Phantom', 'Phantom', 'Phantom', 'Phantom', 'Phantom'],
        ],
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      // Player has 2 aces in same match → one bullet with ×2 and totalAces=2
      expect(text).toContain('MultiAce#MA</b> (2)');
      expect(text).toContain('×2');
      const bulletCount = (text.match(/^• /mg) ?? []).length;
      expect(bulletCount).toBe(1);
    });
  });

  // ── Test 5: One player, aces in two different matches ────────────────────────
  describe('one player, aces in two different matches', () => {
    it('renders two separate bullets', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'TwoMatch', riotTag: 'TM' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'match-a', startedAt: IN_WINDOW, map: 'Lotus' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'match-b', startedAt: IN_WINDOW + 5000, map: 'Pearl' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'match-a', detectedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'match-b', detectedAt: IN_WINDOW + 5000 });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      // Two bullets for two different matches
      expect(text).toContain('Lotus');
      expect(text).toContain('Pearl');
      const bulletCount = (text.match(/^• /mg) ?? []).length;
      expect(bulletCount).toBe(2);

      // Player has 2 total aces
      expect(text).toContain('TwoMatch#TM</b> (2)');
    });
  });

  // ── Test 6: 6-kill ace ───────────────────────────────────────────────────────
  describe('6-kill ace', () => {
    it('shows ", 6 убийств" when weapons_per_round has 6 entries in a round', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SixKiller', riotTag: 'SK' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'six-kill', startedAt: IN_WINDOW, map: 'Fracture' });

      // 6 kills in one round
      const sixKillPayload = {
        weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']],
      };
      sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('ace', 'p1', 'six-kill', ?, ?, 'silent')`,
      ).run(JSON.stringify(sixKillPayload), IN_WINDOW);

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      expect(text).toContain('6 убийств');
    });

    it('does NOT show убийств label for normal 5-kill ace', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'NormalAce', riotTag: 'NA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'five-kill', startedAt: IN_WINDOW, map: 'Abyss' });
      // Default payload: 5 kills per round
      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'five-kill',
        detectedAt: IN_WINDOW,
        weaponsPerRound: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']],
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      expect(result.text).not.toContain('убийств');
    });
  });

  // ── Test 7: excludeEventIds filtering ───────────────────────────────────────
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
        excludeEventIds: [99999], // different ID
      });
      expect(result.text).not.toBeNull();
      expect(result.includedEventIds).toContain(id);
    });
  });

  // ── Test 8: Status filtering ─────────────────────────────────────────────────
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
