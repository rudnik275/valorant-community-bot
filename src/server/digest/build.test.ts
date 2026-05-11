import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { buildDigest } from './build.ts';

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

interface MatchOpts {
  puuid: string;
  matchId?: string;
  startedAt?: number;
  agent?: string;
  kills?: number;
  deaths?: number;
  roundsPlayed?: number;
  map?: string;
  result?: string;
}

function seedMatch(sqlite: Database.Database, opts: MatchOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO match_records
     (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '[]')`,
  ).run(
    opts.puuid,
    opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
    opts.startedAt ?? Date.now(),
    opts.map ?? 'Ascent',
    opts.agent ?? 'Jett',
    opts.kills ?? 15,
    opts.deaths ?? 10,
    opts.result ?? 'win',
    opts.roundsPlayed ?? 20,
  );
}

interface EventOpts {
  puuid: string;
  matchId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  detectedAt?: number;
}

function seedEvent(sqlite: Database.Database, opts: EventOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO detected_events
     (event_type, riot_puuid, match_id, payload_json, detected_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(
    opts.eventType ?? 'ace',
    opts.puuid,
    opts.matchId ?? `match-${Date.now()}-${Math.random()}`,
    JSON.stringify(opts.payload ?? {}),
    opts.detectedAt ?? Date.now(),
  );
}

// ─── Test window constants ────────────────────────────────────────────────────

const NOW = 1_746_000_000_000; // arbitrary fixed point
const WEEK_END = NOW;
const WEEK_START = WEEK_END - 7 * 86400000;
const IN_WINDOW = WEEK_START + 86400000; // 1 day into the window
const OUT_OF_WINDOW = WEEK_START - 86400000; // 1 day before window

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildDigest', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('empty window', () => {
    it('returns text: null when no matches in window', async () => {
      // seed match outside window
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: OUT_OF_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).toBeNull();
      expect(result.sectionsIncluded).toEqual([]);
    });
  });

  describe('all sections render correctly', () => {
    it('renders pulse, epic moment, rank progress, most active, top agents, best K/D with 5 users', async () => {
      // Seed 5 users
      const users = [
        { id: 1, puuid: 'p1', riotName: 'Alpha', riotTag: 'AAA' },
        { id: 2, puuid: 'p2', riotName: 'Beta', riotTag: 'BBB' },
        { id: 3, puuid: 'p3', riotName: 'Gamma', riotTag: 'GGG' },
        { id: 4, puuid: 'p4', riotName: 'Delta', riotTag: 'DDD' },
        { id: 5, puuid: 'p5', riotName: 'Epsilon', riotTag: 'EEE' },
      ];
      for (const u of users) {
        seedUser(sqlite, u.id, u.puuid, { riotName: u.riotName, riotTag: u.riotTag });
      }

      // Seed matches (varying activity)
      // p1: 6 matches (most active), Jett × 3, Sage × 2, Reyna × 1
      for (let i = 0; i < 6; i++) {
        const agent = i < 3 ? 'Jett' : i < 5 ? 'Sage' : 'Reyna';
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, agent, map: 'Ascent' });
      }
      // p2: 5 matches, Jett × 2, Sage × 2, Breach × 1
      for (let i = 0; i < 5; i++) {
        const agent = i < 2 ? 'Jett' : i < 4 ? 'Sage' : 'Breach';
        seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + i * 1000, agent, map: 'Bind' });
      }
      // p3,p4,p5: 3 matches each (less than 5)
      for (const puuid of ['p3', 'p4', 'p5']) {
        for (let i = 0; i < 3; i++) {
          seedMatch(sqlite, { puuid, startedAt: IN_WINDOW + i * 1000, agent: 'Sage', map: 'Haven' });
        }
      }

      // Seed best K/D match: p3 with 20 kills, 2 deaths, 20 rounds
      seedMatch(sqlite, {
        puuid: 'p3',
        matchId: 'best-kd-match',
        startedAt: IN_WINDOW,
        kills: 20,
        deaths: 2,
        roundsPlayed: 20,
        map: 'Pearl',
      });

      // Seed events
      // ace (weight=8) for p1
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'best-kd-match',
        eventType: 'ace',
        payload: { rounds: [1] },
        detectedAt: IN_WINDOW,
      });
      // rank_promo for p2 and p3
      seedEvent(sqlite, {
        puuid: 'p2',
        matchId: 'rank-match-p2',
        eventType: 'rank_promo',
        payload: { from: 'Gold 1', to: 'Platinum 1' },
        detectedAt: IN_WINDOW + 1000,
      });
      seedEvent(sqlite, {
        puuid: 'p3',
        matchId: 'rank-match-p3',
        eventType: 'rank_promo',
        payload: { from: 'Platinum 1', to: 'Diamond 1' },
        detectedAt: IN_WINDOW + 2000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.text).not.toBeNull();
      expect(result.sectionsIncluded).toContain('pulse');
      expect(result.sectionsIncluded).toContain('epicMoment');
      expect(result.sectionsIncluded).toContain('rankProgress');
      expect(result.sectionsIncluded).toContain('mostActive');
      expect(result.sectionsIncluded).toContain('topAgents');
      expect(result.sectionsIncluded).toContain('bestKDMatch');

      const text = result.text!;
      // Pulse
      expect(text).toContain('матчей');
      // Epic moment — ace by p1
      expect(text).toContain('Alpha');
      // Rank progress
      expect(text).toContain('Gold 1');
      expect(text).toContain('Platinum 1');
      expect(text).toContain('Diamond 1');
      // Most active
      expect(text).toContain('Alpha'); // p1 has 6+match matches... but best-kd-match is another insert
      // Top agents — Jett is highest: p1×3 + p2×2 = 5
      expect(text).toContain('Jett');
      // Best KD — p3 (20/2 = 10.0) on Pearl
      expect(text).toContain('Gamma');
      expect(text).toContain('20/2');
    });
  });

  describe('opt-out handling', () => {
    it('top K/D user opted-out → next user picked', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SilentPlayer', riotTag: '000' });
      seedUser(sqlite, 2, 'p2', { riotName: 'ActivePlayer', riotTag: '111' });
      seedOptOut(sqlite, 1, 1); // p1 opted out

      // p1 has best K/D
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, kills: 25, deaths: 1, roundsPlayed: 20, map: 'Ascent' });
      // p2 second best K/D
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW, kills: 15, deaths: 3, roundsPlayed: 15, map: 'Bind' });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('bestKDMatch');
      expect(result.text).toContain('ActivePlayer');
      expect(result.text).not.toContain('SilentPlayer');
    });

    it('all users opted-out → epic/most-active/best-kd omitted, top agents remains', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'User1', riotTag: 'U1' });
      seedUser(sqlite, 2, 'p2', { riotName: 'User2', riotTag: 'U2' });
      seedOptOut(sqlite, 1, 1);
      seedOptOut(sqlite, 2, 1);

      // Seed matches for both (5+ for most-active section)
      for (let i = 0; i < 6; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, agent: 'Jett', roundsPlayed: 20 });
        seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + i * 1000, agent: 'Sage', roundsPlayed: 20 });
      }

      // Seed epic moment for p1 (opted out)
      seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', detectedAt: IN_WINDOW });
      // Seed rank_promo (not affected by opt-out)
      seedEvent(sqlite, { puuid: 'p1', eventType: 'rank_promo', payload: { from: 'Gold', to: 'Plat' }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('epicMoment');
      expect(result.sectionsIncluded).not.toContain('mostActive');
      expect(result.sectionsIncluded).not.toContain('bestKDMatch');
      // top agents still included (aggregate, no opt-out filtering)
      expect(result.sectionsIncluded).toContain('topAgents');
      // rank progress still included (positive individual, opt-out ignored)
      expect(result.sectionsIncluded).toContain('rankProgress');
      expect(result.text).toContain('Gold');
    });
  });

  describe('best K/D gate: ≥10 rounds', () => {
    it('match with 8 rounds is NOT picked for best K/D', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Player2', riotTag: 'P2' });

      // p1: 30/1 but only 8 rounds → should be excluded
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, kills: 30, deaths: 1, roundsPlayed: 8, map: 'Ascent' });
      // p2: 10/2, 15 rounds → should be picked
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW, kills: 10, deaths: 2, roundsPlayed: 15, map: 'Bind' });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('bestKDMatch');
      expect(result.text).toContain('Player2');
      expect(result.text).not.toContain('30/1');
    });

    it('only 8-round match → best K/D section omitted', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW, kills: 30, deaths: 1, roundsPlayed: 8 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('bestKDMatch');
    });
  });

  describe('most active', () => {
    it('omits most-active section when top player has fewer than 5 matches', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });

      // 4 matches — below threshold
      for (let i = 0; i < 4; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('mostActive');
    });

    it('includes most-active section when top player has 5+ matches', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'ActiveOne', riotTag: 'ACT' });

      for (let i = 0; i < 5; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('mostActive');
      expect(result.text).toContain('ActiveOne');
    });
  });

  describe('rank progress', () => {
    it('omits rank-progress section when no rank_promo events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      // no rank_promo events

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('rankProgress');
    });

    it('rank progress events outside window are excluded', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      // event outside window
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'rank_promo',
        payload: { from: 'Gold', to: 'Plat' },
        detectedAt: OUT_OF_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('rankProgress');
    });
  });

  describe('pulse only — no extra filter for mode', () => {
    it('counts all matches in window without additional mode filter (scanner already filtered)', async () => {
      // The scanner only stores competitive — so we just assert we count all records in window,
      // not some subset. This matches behavior: buildDigest does NOT apply a mode filter.
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('pulse');
      // Both matches counted (no mode filter applied)
      expect(result.text).toContain('2 матч');
    });
  });

  describe('epic moment weight ordering', () => {
    it('prefers ace_rare_weapon (weight=10) over ace (weight=8)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PlayerAce', riotTag: 'ACE' });
      seedUser(sqlite, 2, 'p2', { riotName: 'PlayerRare', riotTag: 'RAR' });

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });

      // ace for p1 (older timestamp → would win on tie)
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm1',
        eventType: 'ace',
        detectedAt: IN_WINDOW,
      });
      // ace_rare_weapon for p2 (newer but higher weight)
      seedEvent(sqlite, {
        puuid: 'p2',
        matchId: 'm2',
        eventType: 'ace_rare_weapon',
        detectedAt: IN_WINDOW + 5000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('epicMoment');
      expect(result.text).toContain('PlayerRare'); // ace_rare_weapon wins
    });
  });

  describe('anti-coercion', () => {
    it('does not mention opt-out or silent players in digest text', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'OptedPlayer', riotTag: 'OPT' });
      seedOptOut(sqlite, 1, 1);
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      // If text exists, should not mention opt-out
      if (result.text !== null) {
        expect(result.text).not.toContain('отписался');
        expect(result.text).not.toContain('opt-out');
        expect(result.text).not.toContain('играй больше');
        expect(result.text).not.toContain('вернись');
      }
    });
  });

  describe('record_kills_match section', () => {
    it('renders record_kills_match section when event exists in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'record-match', startedAt: IN_WINDOW, kills: 38, map: 'Ascent' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'record-match',
        eventType: 'record_kills_match',
        payload: { value: 38, prev_value: 30, prev_puuid: 'puuid-other' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('recordKillsMatch');
      expect(result.text).toContain('Мирного рішення не буде');
      expect(result.text).toContain('Killer');
      expect(result.text).toContain('38');
    });

    it('does NOT render record_kills_match section when no events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW, kills: 38 });
      // No record_kills_match event seeded

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('recordKillsMatch');
    });

    it('event outside window is not shown', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW, kills: 38 });
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'record_kills_match',
        payload: { value: 38, prev_value: null, prev_puuid: null },
        detectedAt: OUT_OF_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).not.toContain('recordKillsMatch');
    });
  });
});
