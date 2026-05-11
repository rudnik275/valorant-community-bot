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

const NOW = 1_746_000_000_000; // arbitrary fixed point (used as weekEnd)
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

  describe('#digest hashtag', () => {
    it('always appears as last line', async () => {
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      const lines = result.text!.trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe('#digest');
    });

    it('#digest is last line even when bright events are present', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'm1', eventType: 'ace', detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      const lines = result.text!.trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe('#digest');
    });
  });

  describe('block layout — no Epic Moment, bright events first', () => {
    it('renders bright events in top block, always-sections at bottom', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Beta', riotTag: 'BBB' });

      for (let i = 0; i < 5; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, agent: 'Jett', map: 'Ascent' });
      }
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW, agent: 'Sage', map: 'Bind' });

      // Bright event: ace for p1
      seedEvent(sqlite, { puuid: 'p1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      // Bright event rendered
      expect(text).toContain('Эйс');
      expect(text).toContain('Alpha');

      // Divider present
      expect(text).toContain('━━━━━━━━━━━━━━');

      // Bottom sections present
      expect(text).toContain('матчей'); // pulse
      expect(text).toContain('Jett'); // top agents

      // No Epic Moment section header
      expect(text).not.toContain('Самый яркий момент');

      // Divider appears BEFORE pulse (bright block is above bottom)
      const dividerPos = text.indexOf('━━━━━━━━━━━━━━');
      const pulsePos = text.indexOf('матчей');
      expect(dividerPos).toBeLessThan(pulsePos);
    });

    it('omits divider when no bright events', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      // no bright events

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      expect(result.text).not.toContain('━━━━━━━━━━━━━━');
    });
  });

  describe('pulse simplified', () => {
    it('renders total match count without avg-per-player', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm2', startedAt: IN_WINDOW + 1000 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('pulse');
      expect(result.text).toContain('2 матч');
      // No avg-per-player
      expect(result.text).not.toContain('в среднем');
    });
  });

  describe('top maps section', () => {
    it('renders top 3 maps by match count', async () => {
      seedUser(sqlite, 1, 'p1');
      seedUser(sqlite, 2, 'p2');

      // Ascent: 4, Bind: 3, Haven: 2, Pearl: 1
      for (let i = 0; i < 4; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'Ascent' });
      }
      for (let i = 0; i < 3; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + (i + 10) * 1000, map: 'Bind' });
      }
      for (let i = 0; i < 2; i++) {
        seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + (i + 20) * 1000, map: 'Haven' });
      }
      seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + 30000, map: 'Pearl' });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('topMaps');
      expect(result.text).toContain('Ascent');
      expect(result.text).toContain('Bind');
      expect(result.text).toContain('Haven');
      // Pearl is 4th — should NOT appear (only top 3)
      expect(result.text).not.toContain('Pearl');
    });

    it('renders top maps with count annotations', async () => {
      seedUser(sqlite, 1, 'p1');
      for (let i = 0; i < 3; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'Ascent' });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).toContain('3×');
    });
  });

  describe('all bottom sections render', () => {
    it('renders pulse, top player, top maps, top agents with enough data', async () => {
      const players = [
        { id: 1, puuid: 'p1', riotName: 'Alpha', riotTag: 'AAA' },
        { id: 2, puuid: 'p2', riotName: 'Beta', riotTag: 'BBB' },
        { id: 3, puuid: 'p3', riotName: 'Gamma', riotTag: 'GGG' },
      ];
      for (const u of players) {
        seedUser(sqlite, u.id, u.puuid, { riotName: u.riotName, riotTag: u.riotTag });
      }

      // p1: 6 matches (most active), Jett × 4
      for (let i = 0; i < 6; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, agent: 'Jett', map: 'Ascent' });
      }
      // p2: 3 matches, Sage × 2, Breach × 1
      for (let i = 0; i < 3; i++) {
        const agent = i < 2 ? 'Sage' : 'Breach';
        seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + (i + 10) * 1000, agent, map: 'Bind' });
      }
      // p3: 2 matches, Sage × 2
      for (let i = 0; i < 2; i++) {
        seedMatch(sqlite, { puuid: 'p3', startedAt: IN_WINDOW + (i + 20) * 1000, agent: 'Sage', map: 'Haven' });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      expect(result.sectionsIncluded).toContain('pulse');
      expect(result.sectionsIncluded).toContain('mostActive');
      expect(result.sectionsIncluded).toContain('topMaps');
      expect(result.sectionsIncluded).toContain('topAgents');

      const text = result.text!;
      expect(text).toContain('матчей'); // pulse
      expect(text).toContain('Alpha'); // most active
      expect(text).toContain('Jett'); // top agents
      expect(text).toContain('Ascent'); // top maps
      expect(text).toContain('Bind'); // top maps (2nd)
    });
  });

  describe('bright events — rank_promo', () => {
    it('renders rank promo as a bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'rank_promo',
        payload: { from: 'Gold 1', to: 'Platinum 1' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('rank_promo');
      expect(result.text).toContain('Gold 1');
      expect(result.text).toContain('Platinum 1');
      expect(result.text).toContain('Climber');
    });
  });

  describe('bright events — record_deaths_match', () => {
    it('renders record_deaths_match in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Victim', riotTag: 'VIC' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'deaths-match', startedAt: IN_WINDOW, deaths: 28, map: 'Bind' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'deaths-match',
        eventType: 'record_deaths_match',
        payload: { value: 28, prev_value: 22, prev_puuid: 'puuid-other' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_deaths_match');
      expect(result.text).toContain('Жертва насилия');
      expect(result.text).toContain('Victim');
      expect(result.text).toContain('28');
    });
  });

  describe('bright events — record_headshots_match', () => {
    it('renders record_headshots_match in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Cowboy', riotTag: 'COW' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'hs-match', startedAt: IN_WINDOW, map: 'Ascent' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'hs-match',
        eventType: 'record_headshots_match',
        payload: { value: 24, prev_value: 20, prev_puuid: 'puuid-other' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_headshots_match');
      expect(result.text).toContain('Ковбой недели');
      expect(result.text).toContain('Cowboy');
      expect(result.text).toContain('24');
    });
  });

  describe('bright events — record_legshots_match', () => {
    it('renders record_legshots_match in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'LegPlayer', riotTag: 'LEGS' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'ls-match', startedAt: IN_WINDOW, map: 'Haven' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'ls-match',
        eventType: 'record_legshots_match',
        payload: { value: 18, prev_value: 14, prev_puuid: 'puuid-other' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_legshots_match');
      expect(result.text).toContain('Угадай куда шмальну');
      expect(result.text).toContain('LegPlayer');
      expect(result.text).toContain('18');
    });
  });

  describe('bright events — record_kills_match', () => {
    it('renders record_kills_match in bright block', async () => {
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
      expect(result.sectionsIncluded).toContain('record_kills_match');
      expect(result.text).toContain('Мирного рішення не буде');
      expect(result.text).toContain('Killer');
      expect(result.text).toContain('38');
    });

    it('does NOT render record_kills_match section when no events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW, kills: 38 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('record_kills_match');
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
      expect(result.sectionsIncluded).not.toContain('record_kills_match');
    });
  });

  describe('bright events — record_damage_dealt_match', () => {
    it('renders record_damage_dealt_match in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Butcher', riotTag: 'DMG' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'dmg-match', startedAt: IN_WINDOW, map: 'Ascent' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'dmg-match',
        eventType: 'record_damage_dealt_match',
        payload: { value: 6840, prev_value: 6420, prev_puuid: 'puuid-other', prev_name: 'OtherPlayer', prev_tag: 'OTH' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_damage_dealt_match');
      expect(result.text).toContain('Мясник недели');
      expect(result.text).toContain('Butcher');
      expect(result.text).toContain('6840');
    });

    it('does NOT render record_damage_dealt_match when no events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Butcher', riotTag: 'DMG' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('record_damage_dealt_match');
    });
  });

  describe('bright events — record_damage_received_match', () => {
    it('renders record_damage_received_match in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Victim', riotTag: 'VCT' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'rcv-match', startedAt: IN_WINDOW, map: 'Bind' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'rcv-match',
        eventType: 'record_damage_received_match',
        payload: { value: 5910, prev_value: 5600, prev_puuid: 'puuid-other', prev_name: 'OtherPlayer', prev_tag: 'OTH' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_damage_received_match');
      expect(result.text).toContain('Надругались над');
      expect(result.text).toContain('Victim');
      expect(result.text).toContain('5910');
    });

    it('does NOT render record_damage_received_match when no events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Victim', riotTag: 'VCT' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('record_damage_received_match');
    });
  });

  describe('bright events ordering — weight-based', () => {
    it('renders both ace_rare_weapon_week and ace (all bright events, not just top-1)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PlayerAce', riotTag: 'ACE' });
      seedUser(sqlite, 2, 'p2', { riotName: 'PlayerRare', riotTag: 'RAR' });

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });

      seedEvent(sqlite, { puuid: 'p1', matchId: 'm1', eventType: 'ace', detectedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p2',
        matchId: 'm2',
        eventType: 'ace_rare_weapon_week',
        payload: { weapons_per_round: [['Classic', 'Classic', 'Vandal', 'Vandal', 'Phantom']] },
        detectedAt: IN_WINDOW + 5000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      // Both players appear (unlike old "Epic Moment" which only picked one)
      expect(result.text).toContain('PlayerAce');
      expect(result.text).toContain('PlayerRare');
      expect(result.sectionsIncluded).toContain('ace');
      expect(result.sectionsIncluded).toContain('ace_rare_weapon_week');
    });
  });

  describe('opt-out handling', () => {
    it('opted-out player skipped for ace (non-rank) bright event', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SilentPlayer', riotTag: '000' });
      seedUser(sqlite, 2, 'p2', { riotName: 'ActivePlayer', riotTag: '111' });
      seedOptOut(sqlite, 1, 1); // p1 opted out

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'm1', eventType: 'ace', detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toContain('SilentPlayer');
      expect(result.sectionsIncluded).not.toContain('ace');
    });

    it('opted-out player still gets rank_promo in bright block (positive progress)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedOptOut(sqlite, 1, 1); // p1 opted out
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'rank_promo',
        payload: { from: 'Gold', to: 'Plat' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('rank_promo');
      expect(result.text).toContain('Climber');
    });

    it('opted-out top player skipped for mostActive section', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SilentActive', riotTag: '000' });
      seedUser(sqlite, 2, 'p2', { riotName: 'VisibleActive', riotTag: '111' });
      seedOptOut(sqlite, 1, 1);

      for (let i = 0; i < 6; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000 });
        seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW + i * 1000 + 500 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toContain('SilentActive');
      // p2 also has 6 matches — should appear
      expect(result.text).toContain('VisibleActive');
    });
  });

  describe('empty bright events case — only bottom block + hashtag', () => {
    it('renders only always-sections and #digest when no bright events exist', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      // Only plain matches, no events
      for (let i = 0; i < 3; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      expect(result.text).not.toContain('━━━━━━━━━━━━━━'); // no divider
      expect(result.text).toContain('матчей'); // pulse present
      const lines = result.text!.trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe('#digest');
    });
  });

  describe('most active threshold', () => {
    it('omits most-active section when top player has fewer than 5 matches', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
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

  describe('anti-coercion', () => {
    it('does not mention opt-out or silent players in digest text', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'OptedPlayer', riotTag: 'OPT' });
      seedOptOut(sqlite, 1, 1);
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      if (result.text !== null) {
        expect(result.text).not.toContain('отписался');
        expect(result.text).not.toContain('opt-out');
        expect(result.text).not.toContain('играй больше');
        expect(result.text).not.toContain('вернись');
      }
    });
  });

  describe('removed sections', () => {
    it('does not include bestKDMatch section', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW, kills: 30, deaths: 1, roundsPlayed: 20 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('bestKDMatch');
    });

    it('does not include epicMoment section', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'm1', eventType: 'ace', detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('epicMoment');
      expect(result.text).not.toContain('Самый яркий момент');
    });
  });
});
