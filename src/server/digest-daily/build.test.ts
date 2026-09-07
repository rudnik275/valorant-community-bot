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

  describe('header and legend', () => {
    it('renders plain header and blockquote legend with 4 lines (no italic)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AcePlayer', riotTag: 'ACE' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, map: 'Ascent', agent: 'Omen' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW, rounds: [1], roundsWon: [1] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;

      expect(text).toContain('🍿 Эйсы и ножи за предыдущие 24 часа');
      // Header is plain — no <u>, no <b> wrapping.
      expect(text).not.toContain('<u>🍿');
      expect(text).not.toContain('<b>🍿');

      // Legend is one blockquote with 4 plain lines (no <i>, no <b>).
      // The old 5th line (🔪🪿 «распотрошил гуся») is retired with the
      // AFK-victim split (owner, 2026-08-04) — a knife kill is a knife kill.
      expect(text).toContain(
        '<blockquote>💀 - без победы в раунде\n🏆 - с победой в раунде\n🎯 - Ace\n🔪 - Заколол баранчика</blockquote>',
      );
      expect(text).not.toContain('🪿');
      expect(text).not.toContain('<i>💀');
      expect(text).not.toContain('<i>🏆');

      // Old footer is gone.
      expect(text).not.toContain('<i>Эйсы и ножи');
    });
  });

  describe('single ace, one player', () => {
    it('renders one entry line with leading 🎯, HH:MM, agent, round-won emoji and map link', async () => {
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
      expect(text).toMatch(/🎯 \d{2}:\d{2} <b>AcePlayer#ACE<\/b>/);
      expect(text).toContain(`<b>AcePlayer#ACE</b> · ${agentToEmojiHtml('Omen')} Omen · 🏆round 2 · ${mapToEmojiHtml('Ascent')}<a href="https://tracker.gg/valorant/match/m1">Ascent</a>`);
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

  describe('multi-round event flattening', () => {
    it('one event with 2 rounds renders as 2 separate lines, same time, sorted ascending', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'MultiAce', riotTag: 'MA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mx', startedAt: IN_WINDOW, map: 'Lotus', agent: 'Jett' });

      seedAceEvent(sqlite, {
        puuid: 'p1',
        matchId: 'mx',
        detectedAt: IN_WINDOW,
        rounds: [10, 0], // out of order on purpose → displayed as 1 and 11
        roundsWon: [10], // round 1 lost, round 11 won
      });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;

      // No legacy x2 grouping syntax.
      expect(text).not.toContain('x2 (');

      // Two MultiAce lines, ascending by round (round 1 before round 11).
      const matches = [...text.matchAll(/🎯 (\d{2}:\d{2}) <b>MultiAce#MA<\/b> · .+? · (💀|🏆)round (\d+) ·/g)];
      expect(matches.length).toBe(2);
      expect(matches[0]![3]).toBe('1');
      expect(matches[0]![2]).toBe('💀');
      expect(matches[1]![3]).toBe('11');
      expect(matches[1]![2]).toBe('🏆');
      // Same HH:MM on both lines.
      expect(matches[0]![1]).toBe(matches[1]![1]);

      // Lines separated by a blank line.
      const firstLineIdx = text.indexOf(matches[0]![0]);
      const secondLineIdx = text.indexOf(matches[1]![0]);
      expect(text.slice(firstLineIdx, secondLineIdx)).toContain('\n\n');
    });

    it('dedupes rounds when 2 knife kills landed in the same round (no duplicate line)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'DoubleKnife', riotTag: 'DK' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'dk', startedAt: IN_WINDOW, map: 'Split', agent: 'Sage' });
      // Detector emits rounds=[5,5] when there are 2 knife kills in round 5.
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'dk', detectedAt: IN_WINDOW, rounds: [5, 5], roundsWon: [5] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      const occurrences = text.match(/🔪 \d{2}:\d{2} <b>DoubleKnife#DK<\/b>/g) ?? [];
      expect(occurrences.length).toBe(1);
      expect(text).toContain('🏆round 6');
    });
  });

  describe('chronological interleaving of ace and knife events', () => {
    it('lines from both event types are interleaved in detected_at order with correct leading emoji', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Mixed', riotTag: 'MX' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mix-ace1', startedAt: IN_WINDOW, map: 'Lotus', agent: 'Jett' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mix-kn', startedAt: IN_WINDOW + 30 * 60_000, map: 'Bind', agent: 'Reyna' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'mix-ace2', startedAt: IN_WINDOW + 2 * 3600_000, map: 'Pearl', agent: 'Clove' });

      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'mix-kn', detectedAt: IN_WINDOW + 30 * 60_000, rounds: [7], roundsWon: [] });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'mix-ace1', detectedAt: IN_WINDOW + 60 * 60_000, rounds: [3], roundsWon: [3] });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'mix-ace2', detectedAt: IN_WINDOW + 2 * 3600_000, rounds: [10], roundsWon: [10] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;

      // Body section (after the legend) — collect leading emoji of each event line.
      const bodyMatches = [...text.matchAll(/^(🎯|🔪) \d{2}:\d{2}/gm)];
      expect(bodyMatches.map((m) => m[1])).toEqual(['🔪', '🎯', '🎯']);

      // And map names appear in chronological order.
      const posBind = text.indexOf('Bind');
      const posLotus = text.indexOf('Lotus');
      const posPearl = text.indexOf('Pearl');
      expect(posBind).toBeLessThan(posLotus);
      expect(posLotus).toBeLessThan(posPearl);
    });

    it('multiple players are also ordered by detected_at', async () => {
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
      expect(posEarly).toBeLessThan(posLate);
      expect(posLate).toBeLessThan(posEarlySecond);
    });
  });

  describe('Kyiv HH:MM time formatting', () => {
    it('renders detected_at as Europe/Kyiv HH:MM (zero-padded, 24h)', async () => {
      // 2025-04-29 19:05 UTC = 22:05 Kyiv (UTC+3 in summer, DST in effect).
      const KNOWN_TS = Date.UTC(2025, 3, 29, 19, 5);
      // Sanity-check the chosen timestamp falls inside the test window.
      expect(KNOWN_TS).toBeGreaterThanOrEqual(WIN_START);
      expect(KNOWN_TS).toBeLessThan(WIN_END);

      seedUser(sqlite, 1, 'p1', { riotName: 'TimeTest', riotTag: 'T' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'tm', startedAt: KNOWN_TS, map: 'Ascent', agent: 'Jett' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'tm', detectedAt: KNOWN_TS, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      expect(text).toContain('🎯 22:05 <b>TimeTest#T</b>');
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
      // Round prefix has empty result emoji → " · round 5 · " (space then "round").
      expect(text).toContain(' · round 5');
      expect(text).not.toContain('💀round 5');
      expect(text).not.toContain('🏆round 5');
    });

    it('derives 🏆/💀 from match_records.rounds_compact + kill_events_compact when payload lacks rounds_won', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Legacy', riotTag: 'L' });
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

      // Legacy payload: rounds present but no rounds_won.
      sqlite.prepare(
        `INSERT INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at, status)
         VALUES ('ace', 'p1', 'derive-match', ?, ?, 'silent')`,
      ).run(JSON.stringify({ rounds: [4, 7], weapons_per_round: [['Vandal'], ['Vandal']] }), IN_WINDOW);

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const text = result.text!;
      // Two separate lines, won emoji per round.
      expect(text).toContain('🏆round 5');
      expect(text).toContain('💀round 8');
      expect(text).not.toContain('x2 (');
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

  // ─── Rich Message rendering (#315 / #365) ──────────────────────────────────
  //
  // The legacy `text` field (and every assertion above) stays byte-identical.
  // These tests exercise the PARALLEL `richHtml` field — the per-player count
  // lists the group actually sees: what is NOT there (rank, agent, map, link,
  // rounds), how counting works against the DB payloads, and the no-raw-`\n`
  // contract. Pure model/markup detail is covered in rich-render.test.ts.
  describe('richHtml (rich rendering)', () => {
    /** Seed a match row that also carries a per-match rank (rank_after). */
    function seedRankedMatch(
      s: Database.Database,
      opts: MatchOpts & { rankAfter?: string | null },
    ) {
      s.prepare(
        `INSERT OR REPLACE INTO match_records
         (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact, rank_after)
         VALUES (?, ?, ?, ?, ?, 15, 10, 0, 'win', 20, '[]', ?)`,
      ).run(
        opts.puuid,
        opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
        opts.startedAt ?? Date.now(),
        opts.map ?? 'Ascent',
        opts.agent ?? 'Jett',
        opts.rankAfter ?? null,
      );
    }

    it('returns richHtml=null exactly when there are no qualifying events', async () => {
      seedUser(sqlite, 1, 'p1');
      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).toBeNull();
      expect(result.richHtml).toBeNull();
    });

    it('renders the title, the Aces heading and one bullet per player', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Ace', riotTag: 'ACE' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, map: 'Ascent', agent: 'Jett', rankAfter: 'Diamond 3' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'm1', detectedAt: IN_WINDOW, rounds: [2], roundsWon: [2] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.text).not.toBeNull();
      expect(result.richHtml).toBe(
        '<h2>🍿 Daily Ace/Knife</h2><h3>🎯 Aces</h3><ul><li><b>Ace#ACE</b></li></ul>',
      );
    });

    it('shows NO rank icon, NO agent icon, NO map and NO match link — even when all are known', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Ranked', riotTag: 'RK' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'rk1', startedAt: IN_WINDOW, map: 'Ascent', agent: 'Jett', rankAfter: 'Diamond 3' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'rk1', detectedAt: IN_WINDOW, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const html = result.richHtml!;
      expect(html).toContain('<b>Ranked#RK</b>');
      expect(html).not.toContain('<tg-emoji');
      expect(html).not.toContain('💎');
      expect(html).not.toContain(agentToEmojiHtml('Jett'));
      expect(html).not.toContain(mapToEmojiHtml('Ascent'));
      expect(html).not.toContain('Ascent');
      expect(html).not.toContain('tracker.gg');
      expect(html).not.toContain('🏆');
      expect(html).not.toContain('(');
      // The nick is exactly the global helper's bare form.
      expect(html).toContain(renderPlayerName({ name: 'Ranked', tag: 'RK', isCommunity: true }));
    });

    it('counts aces per aced round: rounds [0, 3] → ×2', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'MultiAce', riotTag: 'MA' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'mx', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'mx', detectedAt: IN_WINDOW, rounds: [0, 3], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.richHtml!).toContain('<li><b>MultiAce#MA</b> ×2</li>');
    });

    it('counts knives per KILL, not per round: rounds [5, 5] → ×2 (the legacy text dedupes to one line)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'DoubleKnife', riotTag: 'DK' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'dk', startedAt: IN_WINDOW });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'dk', detectedAt: IN_WINDOW, rounds: [5, 5], roundsWon: [5] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.richHtml!).toContain('<h3>🔪 Knives</h3><ul><li><b>DoubleKnife#DK</b> ×2</li></ul>');
      // …while the legacy text still lists the round once.
      expect(result.text!.match(/🔪 \d{2}:\d{2} <b>DoubleKnife#DK<\/b>/g)?.length).toBe(1);
    });

    it('sums one player across several matches into a single bullet', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Busy', riotTag: 'BZ' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'b1', startedAt: IN_WINDOW, map: 'Sunset' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'b2', startedAt: IN_WINDOW + 1000, map: 'Ascent' });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'b1', detectedAt: IN_WINDOW, rounds: [11], roundsWon: [11] });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'b2', detectedAt: IN_WINDOW + 1000, rounds: [3, 9], roundsWon: [] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const html = result.richHtml!;
      expect(html).toContain('<li><b>Busy#BZ</b> ×3</li>');
      expect(html.match(/Busy#BZ/g)?.length).toBe(1);
    });

    it('sorts bullets by count desc, ties in detection order', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'First', riotTag: 'F' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Big', riotTag: 'B' });
      seedUser(sqlite, 3, 'p3', { riotName: 'Second', riotTag: 'S' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'f1', startedAt: IN_WINDOW });
      seedRankedMatch(sqlite, { puuid: 'p2', matchId: 'g1', startedAt: IN_WINDOW + 1000 });
      seedRankedMatch(sqlite, { puuid: 'p3', matchId: 's1', startedAt: IN_WINDOW + 2000 });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'f1', detectedAt: IN_WINDOW, rounds: [0], roundsWon: [0] });
      seedAceEvent(sqlite, { puuid: 'p2', matchId: 'g1', detectedAt: IN_WINDOW + 1000, rounds: [0, 4, 8], roundsWon: [0] });
      seedAceEvent(sqlite, { puuid: 'p3', matchId: 's1', detectedAt: IN_WINDOW + 2000, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.richHtml!).toContain(
        '<ul><li><b>Big#B</b> ×3</li><li><b>First#F</b></li><li><b>Second#S</b></li></ul>',
      );
    });

    it('omits the Knives section when only ace events exist (and vice versa)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AceOnly', riotTag: 'AO' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'ao1', startedAt: IN_WINDOW });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'ao1', detectedAt: IN_WINDOW, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      const html = result.richHtml!;
      expect(html).toContain('<h3>🎯 Aces</h3>');
      expect(html).not.toContain('Knives');
    });

    it('renders both sections, Aces first, when both event types exist', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Both', riotTag: 'BO' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'ba', startedAt: IN_WINDOW });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'bk', startedAt: IN_WINDOW + 1000 });
      seedKnifeEvent(sqlite, { puuid: 'p1', matchId: 'bk', detectedAt: IN_WINDOW, rounds: [12], roundsWon: [] });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'ba', detectedAt: IN_WINDOW + 1000, rounds: [0], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.richHtml).toBe(
        '<h2>🍿 Daily Ace/Knife</h2>' +
          '<h3>🎯 Aces</h3><ul><li><b>Both#BO</b></li></ul>' +
          '<h3>🔪 Knives</h3><ul><li><b>Both#BO</b></li></ul>',
      );
    });

    it('produces richHtml with NO raw newline', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'NL', riotTag: 'NL' });
      seedRankedMatch(sqlite, { puuid: 'p1', matchId: 'nl1', startedAt: IN_WINDOW, rankAfter: 'Gold 1' });
      seedAceEvent(sqlite, { puuid: 'p1', matchId: 'nl1', detectedAt: IN_WINDOW, rounds: [0, 3], roundsWon: [0] });

      const result = await buildDailyAceDigest({ db, windowStart: WIN_START, windowEnd: WIN_END });
      expect(result.richHtml!).not.toContain('\n');
    });
  });
});
