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
  headshots?: number;
  legshots?: number;
  damageDealt?: number;
  damageReceived?: number;
  gameLengthMs?: number;
}

function seedMatch(sqlite: Database.Database, opts: MatchOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO match_records
     (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact,
      headshots, legshots, damage_dealt, damage_received, game_length_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '[]', ?, ?, ?, ?, ?)`,
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
    opts.headshots ?? null,
    opts.legshots ?? null,
    opts.damageDealt ?? null,
    opts.damageReceived ?? null,
    opts.gameLengthMs ?? null,
  );
}

interface AllTimeRecordOpts {
  recordType: string;
  value: number;
  puuid: string;
  matchId?: string;
}

function seedAllTimeRecord(sqlite: Database.Database, opts: AllTimeRecordOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO all_time_records
     (record_type, weapon, riot_puuid, value, match_id, achieved_at)
     VALUES (?, '', ?, ?, ?, ?)`,
  ).run(
    opts.recordType,
    opts.puuid,
    opts.value,
    opts.matchId ?? `match-atr-${Date.now()}`,
    Date.now(),
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

      // Bright event: winstreak for p1
      seedEvent(sqlite, { puuid: 'p1', eventType: 'winstreak_10plus', payload: { streak: 10 }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toBeNull();
      const text = result.text!;

      // Bright event rendered
      expect(text.toLowerCase()).toContain('винстрик');
      expect(text).toContain('Alpha');

      // Divider removed per user — no longer rendered between bright block and weekly recap.
      expect(text).not.toContain('━━━━━━━━━━━━━━');

      // Bottom sections present
      expect(text).toContain('матчей'); // pulse
      expect(text).toContain('Jett'); // top agents

      // No Epic Moment section header
      expect(text).not.toContain('Самый яркий момент');

      // Bright block appears BEFORE weekly recap.
      const brightPos = text.toLowerCase().indexOf('винстрик');
      const pulsePos = text.indexOf('матчей');
      expect(brightPos).toBeLessThan(pulsePos);
    });

    it('still has no divider when there are no bright events', async () => {
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
      expect(result.text).toContain('<b>2</b> матч');
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

  describe('bright events — peak_rank_up', () => {
    it('renders peak rank up as a bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'peak_rank_up',
        payload: { from_tier_name: 'Gold 1', to_tier_name: 'Platinum 1' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('peak_rank_up');
      // New format drops `from_tier_name` from output — only `to_tier_name` shown
      expect(result.text).toContain('Platinum 1');
      expect(result.text).toContain('Climber');
      expect(result.text).toContain('Повышение по службе');
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
      expect(result.text).toContain('Директор дикого запада');
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
      expect(result.text).toContain('Серийный маньяк');
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
      expect(result.text).toContain('Мясник');
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
      expect(result.text).toContain('Груша для битья');
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
    it('renders multiple bright events (all included, not just top-1)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'PlayerKills', riotTag: 'KLL' });
      seedUser(sqlite, 2, 'p2', { riotName: 'PlayerWin', riotTag: 'WIN' });

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });

      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm1',
        eventType: 'record_kills_match',
        payload: { value: 35, prev_value: null, prev_puuid: null },
        detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p2',
        matchId: 'w1',
        eventType: 'winstreak_10plus',
        payload: { streak: 12 },
        detectedAt: IN_WINDOW + 5000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      // Both players appear
      expect(result.text).toContain('PlayerKills');
      expect(result.text).toContain('PlayerWin');
      expect(result.sectionsIncluded).toContain('record_kills_match');
      expect(result.sectionsIncluded).toContain('winstreak_10plus');
    });

    it('does NOT include ace or giant_slayer in digest (realtime-only)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'AcePlayer', riotTag: 'ACE' });
      seedUser(sqlite, 2, 'p2', { riotName: 'GiantSlayer', riotTag: 'GST' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'm1', eventType: 'ace', detectedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p2', matchId: 'm2', eventType: 'giant_slayer', detectedAt: IN_WINDOW + 1000 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('ace');
      expect(result.sectionsIncluded).not.toContain('giant_slayer');
    });
  });

  describe('opt-out handling', () => {
    it('opted-out player skipped for winstreak (non-rank) bright event', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'SilentPlayer', riotTag: '000' });
      seedUser(sqlite, 2, 'p2', { riotName: 'ActivePlayer', riotTag: '111' });
      seedOptOut(sqlite, 1, 1); // p1 opted out

      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'm1',
        eventType: 'winstreak_10plus',
        payload: { streak: 10 },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).not.toContain('SilentPlayer');
      expect(result.sectionsIncluded).not.toContain('winstreak_10plus');
    });

    it('opted-out player still gets peak_rank_up in bright block (positive progress)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedOptOut(sqlite, 1, 1); // p1 opted out
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1',
        eventType: 'peak_rank_up',
        payload: { from_tier_name: 'Gold', to_tier_name: 'Plat' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('peak_rank_up');
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

  describe('bright events — record_longest_match_minutes', () => {
    it('renders record_longest_match_minutes in bright block', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'LongPlayer', riotTag: 'LNG' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'long-match', startedAt: IN_WINDOW, map: 'Breeze' });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'long-match',
        eventType: 'record_longest_match_minutes',
        payload: {
          value: 52,
          rounds: 28,
          result: 'win',
          prev_value: 45,
          prev_puuid: 'other-puuid',
          prev_name: 'OldHolder',
          prev_tag: 'OHD',
          community_players: [{ puuid: 'p1', name: 'LongPlayer', tag: 'LNG' }],
        },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_longest_match_minutes');
      expect(result.text).toContain('Дело принципа');
      expect(result.text).toContain('52 минут');
      expect(result.text).toContain('(28 раундов)');
      expect(result.text).toContain('🏆');
      expect(result.text).toContain('LongPlayer#LNG');
    });

    it('does NOT render record_longest_match_minutes when no events in window', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('record_longest_match_minutes');
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

  describe('near-miss — «Был близок к рекорду»', () => {
    it('renders near-miss block when week max is within threshold of all-time record', async () => {
      // Record holder (historical — not this week's match)
      seedUser(sqlite, 99, 'p-holder', { riotName: 'RecordHolder', riotTag: 'REC' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 30, puuid: 'p-holder', matchId: 'old-match' });

      // Current week: player gets 29 kills (within threshold of 2)
      seedUser(sqlite, 1, 'p1', { riotName: 'NearMisser', riotTag: 'NM' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'nm-match', startedAt: IN_WINDOW, kills: 29 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('nearMiss');
      expect(result.text).toContain('Был(ла) близко к рекорду по киллам');
      expect(result.text).toContain('NearMisser');
      expect(result.text).toContain('29');
      expect(result.text).toContain('30');
    });

    it('does NOT render near-miss when week max is beyond threshold', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'RecordHolder', riotTag: 'REC' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 30, puuid: 'p-holder', matchId: 'old-match' });

      // 27 kills — more than 2 below record (threshold = 2), so not a near-miss
      seedUser(sqlite, 1, 'p1', { riotName: 'FarOff', riotTag: 'FAR' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'far-match', startedAt: IN_WINDOW, kills: 27 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('близко к рекорду');
    });

    it('does NOT render near-miss when that record was beaten this week (record event exists)', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'OldHolder', riotTag: 'OLD' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 30, puuid: 'p-holder', matchId: 'old-match' });

      // Player beats the record this week
      seedUser(sqlite, 1, 'p1', { riotName: 'Beater', riotTag: 'BTR' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'beat-match', startedAt: IN_WINDOW, kills: 35 });
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'beat-match',
        eventType: 'record_kills_match',
        payload: { value: 35, prev_value: 30 },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      // Record event was rendered (bright block), near-miss should NOT appear
      expect(result.sectionsIncluded).toContain('record_kills_match');
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('близко к рекорду');
    });

    it('renders multiple near-miss blocks for different record types', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 30, puuid: 'p-holder', matchId: 'old-kills' });
      seedAllTimeRecord(sqlite, { recordType: 'deaths_match', value: 20, puuid: 'p-holder', matchId: 'old-deaths' });

      seedUser(sqlite, 1, 'p1', { riotName: 'MultiNear', riotTag: 'MNR' });
      // Close on kills (29/30) and deaths (19/20)
      seedMatch(sqlite, { puuid: 'p1', matchId: 'nm-multi', startedAt: IN_WINDOW, kills: 29, deaths: 19 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('nearMiss');
      // Both near-miss blocks should appear
      expect(result.text).toContain('рекорду по киллам');
      expect(result.text).toContain('жертвой насилия');
    });

    it('does NOT render near-miss when no all-time record row exists for that type', async () => {
      // No all_time_records seeded at all
      seedUser(sqlite, 1, 'p1', { riotName: 'Player1', riotTag: 'P1' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW, kills: 29 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('близко к рекорду');
    });

    it('near-miss for damage_dealt renders with correct emoji and unit', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'damage_dealt_match', value: 7000, puuid: 'p-holder', matchId: 'old-dmg' });

      seedUser(sqlite, 1, 'p1', { riotName: 'AlmostDmg', riotTag: 'DMG' });
      // 6500 is within 1000 of 7000
      seedMatch(sqlite, { puuid: 'p1', matchId: 'dmg-near', startedAt: IN_WINDOW, damageDealt: 6500 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('nearMiss');
      expect(result.text).toContain('мясником недели');
      expect(result.text).toContain('dmg');
      expect(result.text).toContain('AlmostDmg');
    });
  });
});
