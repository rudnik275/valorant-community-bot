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
  isMatchMvp?: number;
  survivedLastRounds?: number;
  diedFirstRounds?: number;
  /** Henrik tier name for this match (e.g. "Diamond 3") — drives rank emoji in rich accordions. */
  rankAfter?: string;
}

function seedMatch(sqlite: Database.Database, opts: MatchOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO match_records
     (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact,
      headshots, legshots, damage_dealt, damage_received, game_length_ms, is_match_mvp, survived_last_rounds, died_first_rounds, rank_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    opts.isMatchMvp ?? null,
    opts.survivedLastRounds ?? null,
    opts.diedFirstRounds ?? null,
    opts.rankAfter ?? null,
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

interface WeeklyRecordOpts {
  recordType: string;
  weekIso: string;
  puuid: string;
  value: number;
}

function seedWeeklyRecord(sqlite: Database.Database, opts: WeeklyRecordOpts) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO weekly_records (record_type, week_iso, riot_puuid, value)
     VALUES (?, ?, ?, ?)`,
  ).run(opts.recordType, opts.weekIso, opts.puuid, opts.value);
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
      expect(text).toContain('🎭 <b>Агенты недели</b>'); // agents board (rows are pack icons, not names)

      // No Epic Moment section header
      expect(text).not.toContain('Самый яркий момент');

      // The pulse line now LEADS the digest (approved flat layout, 2026-08-04):
      // «📊 За неделю мы сыграли N матчей» sits directly under the title, with
      // the bright content below it.
      const brightPos = text.toLowerCase().indexOf('винстрик');
      const pulsePos = text.indexOf('матчей');
      expect(pulsePos).toBeLessThan(brightPos);
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
    it('renders EVERY map played, desc by match count (no top-3 cut)', async () => {
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
      // Owner asked for «топ всех карт» — the 4th map appears too.
      expect(result.text).toContain('Pearl');
      // Podium order, then a bullet for the tail.
      expect(result.text).toMatch(/🥇 .*Ascent — 4/);
      expect(result.text).toMatch(/🥈 .*Bind — 3/);
      expect(result.text).toMatch(/🥉 .*Haven — 2/);
      expect(result.text).toMatch(/• .*Pearl — 1/);
    });

    it('renders top maps with count annotations', async () => {
      seedUser(sqlite, 1, 'p1');
      for (let i = 0; i < 3; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'Ascent' });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).toContain('🗺 <b>Карты недели</b>');
      expect(result.text).toMatch(/🥇 .*Ascent — 3/);
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
      expect(text).toContain('🎭 <b>Агенты недели</b>'); // agents board (rows are pack icons, not names)
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
      // #301: rank → emoji only (Platinum 1 → 🐳), tier text dropped.
      expect(result.text).toContain('<tg-emoji emoji-id="5264763678711913942">🐳</tg-emoji>');
      expect(result.text).not.toContain('Platinum 1');
      expect(result.text).toContain('Climber');
      expect(result.text).toContain('Повышение по службе');
    });

    it('dedups multiple ups for one player to the highest rank (singular header)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      // Scanner emits one event per tier transition: Diamond 1 → 2 → 3.
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'peak:21', eventType: 'peak_rank_up',
        payload: { to_tier_id: 21, to_tier_name: 'Diamond 1' }, detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'peak:22', eventType: 'peak_rank_up',
        payload: { to_tier_id: 22, to_tier_name: 'Diamond 2' }, detectedAt: IN_WINDOW + 1000,
      });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'peak:23', eventType: 'peak_rank_up',
        payload: { to_tier_id: 23, to_tier_name: 'Diamond 3' }, detectedAt: IN_WINDOW + 2000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const text = result.text!;
      expect(result.sectionsIncluded).toContain('peak_rank_up');
      // #301: rank → emoji only. Only the final (highest) rank survives, once.
      // Diamond 3 → id 5265219666799795636; Diamond 1/2 ids must be absent.
      expect(text).toContain('emoji-id="5265219666799795636"');
      expect(text).not.toContain('emoji-id="5265104119294632981"'); // Diamond 1
      expect(text).not.toContain('emoji-id="5267319149893295528"'); // Diamond 2
      expect(text.split('emoji-id="5265219666799795636"').length - 1).toBe(1);
      // One player ⇒ singular header.
      expect(text).toContain('Повышение по службе');
      expect(text).not.toContain('Повышения по службе');
    });

    it('keeps one line per player when several players rank up (plural header)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Rocket', riotTag: 'GG' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm1', startedAt: IN_WINDOW });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'm2', startedAt: IN_WINDOW });
      // p1: Diamond 1 → 2; p2: Plat 1 → 2 → 3.
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'peak:21', eventType: 'peak_rank_up',
        payload: { to_tier_id: 21, to_tier_name: 'Diamond 1' }, detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'peak:22', eventType: 'peak_rank_up',
        payload: { to_tier_id: 22, to_tier_name: 'Diamond 2' }, detectedAt: IN_WINDOW + 1000,
      });
      seedEvent(sqlite, {
        puuid: 'p2', matchId: 'peak:18', eventType: 'peak_rank_up',
        payload: { to_tier_id: 18, to_tier_name: 'Platinum 1' }, detectedAt: IN_WINDOW + 500,
      });
      seedEvent(sqlite, {
        puuid: 'p2', matchId: 'peak:20', eventType: 'peak_rank_up',
        payload: { to_tier_id: 20, to_tier_name: 'Platinum 3' }, detectedAt: IN_WINDOW + 1500,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const text = result.text!;
      // #301: rank → emoji only. Each player appears once, at their highest rank.
      expect(text).toContain('emoji-id="5267319149893295528"'); // p1 Diamond 2
      expect(text).toContain('emoji-id="5267162911867968040"'); // p2 Platinum 3
      expect(text).not.toContain('emoji-id="5265104119294632981"'); // Diamond 1
      expect(text).not.toContain('emoji-id="5264763678711913942"'); // Platinum 1
      expect(text).toContain('Climber');
      expect(text).toContain('Rocket');
      // Two players ⇒ plural header.
      expect(text).toContain('Повышения по службе');
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
      expect(result.text).toContain('Магнит для пуль');
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

  describe('near-miss — opt-out, ties and unknown players', () => {
    /** Record holder + the all-time bar every case below aims just under. */
    function seedKillsBar(value = 30) {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'RecordHolder', riotTag: 'REC' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value, puuid: 'p-holder', matchId: 'old-match' });
    }

    it('names every player tied on the week-best, not just one', async () => {
      // The old query was a bare MAX() over the whole table — one row, so a
      // co-holder was dropped by the query itself.
      seedKillsBar();
      seedUser(sqlite, 1, 'p-aa', { riotName: 'Ann', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p-zz', { riotName: 'Zed', riotTag: 'ZZZ' });
      seedMatch(sqlite, { puuid: 'p-aa', matchId: 'nm-a', startedAt: IN_WINDOW, kills: 29 });
      seedMatch(sqlite, { puuid: 'p-zz', matchId: 'nm-z', startedAt: IN_WINDOW, kills: 29 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('<b>Ann#AAA</b>');
      expect(result.richHtml!).toContain('<b>Zed#ZZZ</b>');
      // One block, two lines — never two blocks.
      expect(result.richHtml!.match(/Был\(ла\) близко к рекорду по киллам/g)).toHaveLength(1);
      // Each line links its OWN match: they got there in different games.
      expect(result.richHtml!).toContain('nm-a');
      expect(result.richHtml!).toContain('nm-z');
    });

    it('skips an opted-out player and falls through to the next one who was close', async () => {
      // Near-misses were the ONE section that never consulted the opt-out set.
      seedKillsBar();
      seedUser(sqlite, 1, 'p-out', { riotName: 'Hidden', riotTag: 'OUT' });
      seedOptOut(sqlite, 1, 1);
      seedUser(sqlite, 2, 'p-in', { riotName: 'Shown', riotTag: 'IN' });
      seedMatch(sqlite, { puuid: 'p-out', matchId: 'nm-out', startedAt: IN_WINDOW, kills: 29 });
      seedMatch(sqlite, { puuid: 'p-in', matchId: 'nm-in', startedAt: IN_WINDOW, kills: 28 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).not.toContain('Hidden');
      expect(result.richHtml!).toContain('<b>Shown#IN</b>');
      expect(result.richHtml!).toContain('28');
    });

    it('never prints a raw PUUID for a player with no member row', async () => {
      // match_records.riot_puuid is ON DELETE SET NULL only for the FK — a
      // departed member can still leave rows whose puuid has no users row, and
      // the old fallback printed the 78-character puuid as the nick.
      seedKillsBar();
      seedUser(sqlite, 1, 'p-known', { riotName: 'Known', riotTag: 'KN' });
      sqlite.prepare(
        `INSERT OR REPLACE INTO match_records
         (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
         VALUES (?, ?, ?, 'Ascent', 'Jett', 29, 5, 2, 'win', 25, '[]')`,
      ).run('puuid-with-no-user-row', 'nm-ghost', IN_WINDOW);
      seedMatch(sqlite, { puuid: 'p-known', matchId: 'nm-known', startedAt: IN_WINDOW, kills: 28 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).not.toContain('puuid-with-no-user-row');
      expect(result.richHtml!).toContain('<b>Known#KN</b>');
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
      expect(result.text).toContain('Магнитом для пуль');
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

    // mvp_count_week near-miss cases

    it('mvp_count_week near-miss: floor-skip — weekly leader below floor=10, no block', async () => {
      // All-time record = 15 (seeded in both all_time_records AND weekly_records
      // so computeAndEmitWeeklyMvpRecord does not emit a false bright event)
      seedUser(sqlite, 99, 'p-holder', { riotName: 'MVPHolder', riotTag: 'MVP' });
      seedAllTimeRecord(sqlite, { recordType: 'mvp_count_week', value: 15, puuid: 'p-holder', matchId: 'old-mvp' });
      seedWeeklyRecord(sqlite, { recordType: 'mvp_count_week', weekIso: '2025-W01', puuid: 'p-holder', value: 15 });

      // Weekly leader: 8 MVPs — below floor=10
      seedUser(sqlite, 1, 'p1', { riotName: 'LowMVP', riotTag: 'LOW' });
      for (let i = 0; i < 8; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-floor-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('королём MVP');
    });

    it('mvp_count_week near-miss: hit — 14 MVPs with all-time=15 (within threshold=2, above floor=10)', async () => {
      // All-time record = 15 (seeded in both all_time_records AND weekly_records
      // so computeAndEmitWeeklyMvpRecord does not emit a false bright event for 14 MVPs)
      seedUser(sqlite, 99, 'p-holder', { riotName: 'MVPHolder', riotTag: 'MVP' });
      seedAllTimeRecord(sqlite, { recordType: 'mvp_count_week', value: 15, puuid: 'p-holder', matchId: 'old-mvp' });
      seedWeeklyRecord(sqlite, { recordType: 'mvp_count_week', weekIso: '2025-W01', puuid: 'p-holder', value: 15 });

      // Weekly leader: 14 MVPs — >=floor and within threshold
      seedUser(sqlite, 1, 'p1', { riotName: 'AlmostKing', riotTag: 'AK' });
      for (let i = 0; i < 14; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-hit-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('nearMiss');
      expect(result.text).toContain('Был(а) близок(ка) к тому чтобы стать королём MVP за неделю');
      expect(result.text).toContain('AlmostKing');
      expect(result.text).toContain('14');
    });

    it('mvp_count_week near-miss: beyond threshold — 11 MVPs with all-time=15 (delta=4 > threshold=2)', async () => {
      // All-time record = 15 (seeded in both tables to prevent false bright event)
      seedUser(sqlite, 99, 'p-holder', { riotName: 'MVPHolder', riotTag: 'MVP' });
      seedAllTimeRecord(sqlite, { recordType: 'mvp_count_week', value: 15, puuid: 'p-holder', matchId: 'old-mvp' });
      seedWeeklyRecord(sqlite, { recordType: 'mvp_count_week', weekIso: '2025-W01', puuid: 'p-holder', value: 15 });

      // Weekly leader: 11 MVPs — >=floor but delta=4 > threshold=2
      seedUser(sqlite, 1, 'p1', { riotName: 'TooFarMVP', riotTag: 'TFM' });
      for (let i = 0; i < 11; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-far-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('королём MVP за неделю');
    });

    it('mvp_count_week near-miss: beaten — 16 MVPs with all-time=15 → bright event fires, no near-miss duplication', async () => {
      // All-time record = 15
      seedUser(sqlite, 99, 'p-holder', { riotName: 'MVPHolder', riotTag: 'MVP' });
      seedAllTimeRecord(sqlite, { recordType: 'mvp_count_week', value: 15, puuid: 'p-holder', matchId: 'old-mvp' });

      // Weekly leader beats the record with 16 MVPs — bright event emitted
      seedUser(sqlite, 1, 'p1', { riotName: 'NewKing', riotTag: 'NK' });
      for (let i = 0; i < 16; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-beat-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1 });
      }
      // Seed the bright record event (as computeAndEmitWeeklyMvpRecord would in production)
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'mvp-beat-0',
        eventType: 'record_mvp_count_week',
        payload: { value: 16, prev_value: 15, prev_puuid: 'p-holder', prev_name: 'MVPHolder', prev_tag: 'MVP' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      // Bright event rendered, no near-miss duplication
      expect(result.sectionsIncluded).toContain('record_mvp_count_week');
      expect(result.text).toContain('Король MVP за неделю');
      // Near-miss should NOT appear
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('близок(ка) к тому чтобы стать королём MVP');
    });

    it('mvp_count_week near-miss: no all-time record row → no near-miss', async () => {
      // No all_time_records seeded for mvp_count_week
      seedUser(sqlite, 1, 'p1', { riotName: 'MvpPlayer', riotTag: 'MP' });
      for (let i = 0; i < 12; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-none-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1 });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('nearMiss');
      expect(result.text).not.toContain('королём MVP');
    });

    it('near-miss for died_first_rounds renders with correct emoji and header', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'died_first_rounds_match', value: 6, puuid: 'p-holder', matchId: 'old-dfr' });

      seedUser(sqlite, 1, 'p1', { riotName: 'AlmostTrojan', riotTag: 'TRJ' });
      // 5 is within threshold=1 of 6
      seedMatch(sqlite, { puuid: 'p1', matchId: 'dfr-near', startedAt: IN_WINDOW, diedFirstRounds: 5 });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('nearMiss');
      expect(result.text).toContain('троянским конём');
      expect(result.text).toContain('AlmostTrojan');
    });
  });

  // ─── Rich HTML rendering (#315) — produced from the SAME data pass ────────────
  describe('ace / knife weekly leaderboards (was the daily digest)', () => {
    it('renders «кто сколько эйсов сделал» and «кто сколько ножей сделал» as counts', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Beta', riotTag: 'BBB' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      // Alpha: 3 aced rounds across two matches. Beta: 1.
      seedEvent(sqlite, { puuid: 'p1', matchId: 'a1', eventType: 'ace', payload: { rounds: [3, 11] }, detectedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'a2', eventType: 'ace', payload: { rounds: [7] }, detectedAt: IN_WINDOW + 1000 });
      seedEvent(sqlite, { puuid: 'p2', matchId: 'a3', eventType: 'ace', payload: { rounds: [4] }, detectedAt: IN_WINDOW + 2000 });
      // Beta: 2 knife kills. One victim was AFK, but that no longer changes
      // anything — the goose split is retired.
      seedEvent(sqlite, {
        puuid: 'p2', matchId: 'k1', eventType: 'knife_kill',
        payload: { count: 2, rounds: [5, 6], victims_afk: [true, false] },
        detectedAt: IN_WINDOW + 3000,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;

      expect(result.sectionsIncluded).toContain('aces');
      expect(result.sectionsIncluded).toContain('knives');
      expect(html).toContain('🎯 <b>Эйсы недели</b>');
      expect(html).toContain('🥇 <b>Alpha#AAA</b> — 3');
      expect(html).toContain('🥈 <b>Beta#BBB</b> — 1');
      expect(html).toContain('🔪 <b>Ножи недели</b>');
      expect(html).toContain('🥇 <b>Beta#BBB</b> — 2');
      expect(html).not.toContain('🪿');

      // Counts only — no per-round detail survives from the daily digest.
      expect(html).not.toContain('round');
      expect(html).not.toContain('раунд 3');

      // The text twin carries the same boards.
      expect(result.text).toContain('🎯 <b>Эйсы недели</b>');
      expect(result.text).toContain('🔪 <b>Ножи недели</b>');
    });

    it('omits both boards when the week had no aces or knives', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).not.toContain('aces');
      expect(result.sectionsIncluded).not.toContain('knives');
      expect(result.richHtml!).not.toContain('Эйсы недели');
      expect(result.richHtml!).not.toContain('Ножи недели');
    });

    it('excludes an opted-out player from the boards', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Beta', riotTag: 'BBB' });
      seedOptOut(sqlite, 1, 1);
      seedMatch(sqlite, { puuid: 'p2', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'a1', eventType: 'ace', payload: { rounds: [1, 2] }, detectedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p2', matchId: 'a2', eventType: 'ace', payload: { rounds: [3] }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('<b>Beta#BBB</b> — 1');
      expect(html).not.toContain('Alpha#AAA');
    });

    it('ace/knife events never leak into the bright-records area', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', matchId: 'a1', eventType: 'ace', payload: { rounds: [1] }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      // They are weekly events, but they are NOT bright records — the only
      // place they appear is their own leaderboard.
      expect(result.sectionsIncluded).not.toContain('ace');
      expect(result.sectionsIncluded).not.toContain('knife_kill');
    });
  });

  describe('Троянский конь / Якорь — records that used to be detected but never shown', () => {
    it('renders record_died_first_rounds as a normal bright record', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'died_first_rounds_match', value: 3, puuid: 'p-holder' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Horse', riotTag: 'TRJ' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'tk-m', startedAt: IN_WINDOW, map: 'Bind', agent: 'Sova' });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'tk-m', eventType: 'record_died_first_rounds',
        payload: { value: 6 }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_died_first_rounds');
      expect(result.richHtml!).toContain('🐴 <b>Троянский конь</b>');
      expect(result.richHtml!).toContain('6 первых смертей');
      expect(result.richHtml!).toContain('<b>Horse#TRJ</b>');
    });

    it('renders record_survived_last_rounds as ⚓ Якорь', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'survived_last_rounds_match', value: 3, puuid: 'p-holder' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Anchor', riotTag: 'ANC' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'an-m', startedAt: IN_WINDOW, map: 'Lotus' });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'an-m', eventType: 'record_survived_last_rounds',
        payload: { value: 7 }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.sectionsIncluded).toContain('record_survived_last_rounds');
      expect(result.richHtml!).toContain('⚓ <b>Якорь</b>');
      expect(result.richHtml!).toContain('7 последних смертей');
    });

    it('suppresses the near-miss line when the Троянский конь record itself fired', async () => {
      // Regression guard: the event is `record_died_first_rounds` but the
      // all_time_records key is `died_first_rounds_match`. A naive prefix strip
      // would not match, and the digest would print both the record AND
      // «чуть не стал троянским конём недели».
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'died_first_rounds_match', value: 3, puuid: 'p-holder' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Horse', riotTag: 'TRJ' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'tk-m', startedAt: IN_WINDOW, diedFirstRounds: 6 });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'tk-m', eventType: 'record_died_first_rounds',
        payload: { value: 6 }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('🐴 <b>Троянский конь</b>');
      expect(result.richHtml!).not.toContain('Чуть не стал(а) троянским конём недели');
    });

    it('collapses a week-long chain of Троянский конь breaks into ONE block', async () => {
      // The live bug: the record was beaten four times in one week (1 → 3 → 4
      // → 9) and the digest printed «🐴 Троянский конь» four times, because
      // this type was missing from the collapse allowlist (owner, 2026-08-09).
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'died_first_rounds_match', value: 0, puuid: 'p-holder' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Horse', riotTag: 'TRJ' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Pony', riotTag: 'PNY' });

      const chain = [
        { puuid: 'p1', matchId: 'ch-1', value: 1, map: 'Summit' },
        { puuid: 'p2', matchId: 'ch-2', value: 3, map: 'Haven' },
        { puuid: 'p1', matchId: 'ch-3', value: 4, map: 'Sunset' },
        { puuid: 'p2', matchId: 'ch-4', value: 9, map: 'Haven' },
      ];
      chain.forEach((c, i) => {
        seedMatch(sqlite, { puuid: c.puuid, matchId: c.matchId, startedAt: IN_WINDOW, map: c.map });
        seedEvent(sqlite, {
          puuid: c.puuid, matchId: c.matchId, eventType: 'record_died_first_rounds',
          payload: { value: c.value }, detectedAt: IN_WINDOW + i,
        });
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!.match(/🐴 <b>Троянский конь<\/b>/g)).toHaveLength(1);
      // The surviving block is the record as it stands at week's end.
      expect(result.richHtml!).toContain('9 первых смертей');
      expect(result.richHtml!).toContain('<b>Pony#PNY</b>');
      expect(result.richHtml!).not.toContain('4 первых смертей');
    });

    it('collapses two Якорь breaks by different players to the best one', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'survived_last_rounds_match', value: 0, puuid: 'p-holder' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Anchor', riotTag: 'ANC' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Chain', riotTag: 'CHN' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'an-1', startedAt: IN_WINDOW, map: 'Summit' });
      seedMatch(sqlite, { puuid: 'p2', matchId: 'an-2', startedAt: IN_WINDOW, map: 'Lotus' });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'an-1', eventType: 'record_survived_last_rounds',
        payload: { value: 5 }, detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p2', matchId: 'an-2', eventType: 'record_survived_last_rounds',
        payload: { value: 6 }, detectedAt: IN_WINDOW + 1,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!.match(/⚓ <b>Якорь<\/b>/g)).toHaveLength(1);
      expect(result.richHtml!).toContain('6 последних смертей');
      expect(result.richHtml!).toContain('<b>Chain#CHN</b>');
    });
  });

  describe('readOnly — the owner preview must not touch prod state', () => {
    it('writes no weekly MVP record and emits no event', async () => {
      // `/test_digest 30` builds over an arbitrary window. Without readOnly it
      // stamped that 30-day MVP count onto the CURRENT week's record row and
      // inserted a `record_mvp_count_week` event dated now — which then landed
      // as a bogus «👑 Король MVP за неделю» in the group's next real digest,
      // and raised the all-time bar so a genuine record could never beat it.
      seedUser(sqlite, 1, 'p1', { riotName: 'King', riotTag: 'KNG' });
      for (let i = 0; i < 4; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-${i}`, startedAt: IN_WINDOW, isMatchMvp: 1 });
      }

      await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END, readOnly: true });

      const events = sqlite
        .prepare(`SELECT id FROM detected_events WHERE event_type = 'record_mvp_count_week'`)
        .all();
      const weekly = sqlite.prepare('SELECT record_type FROM weekly_records').all();
      expect(events).toHaveLength(0);
      expect(weekly).toHaveLength(0);
    });

    it('a normal build still records the weekly MVP', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'King', riotTag: 'KNG' });
      for (let i = 0; i < 4; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-${i}`, startedAt: IN_WINDOW, isMatchMvp: 1 });
      }

      await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });

      const weekly = sqlite.prepare('SELECT record_type FROM weekly_records').all();
      expect(weekly.length).toBeGreaterThan(0);
    });
  });

  describe('no duplicate rows anywhere in the digest', () => {
    it('collapses EVERY record type, including ones added later', async () => {
      // The collapse used to be an opt-in allowlist that failed open. This
      // walks the whole record family so a newly-surfaced type cannot ship
      // without collapsing — the way 🐴/⚓ did.
      const cases: Array<{ eventType: string; recordType: string; title: string }> = [
        { eventType: 'record_kills_match', recordType: 'kills_match', title: '💀 <b>Серийный маньяк</b>' },
        { eventType: 'record_deaths_match', recordType: 'deaths_match', title: '⚰️ <b>Магнит для пуль</b>' },
        { eventType: 'record_headshots_match', recordType: 'headshots_match', title: '🤠 <b>Директор дикого запада</b>' },
        { eventType: 'record_legshots_match', recordType: 'legshots_match', title: '♿️ <b>Угадай куда шмальну</b>' },
        { eventType: 'record_damage_dealt_match', recordType: 'damage_dealt_match', title: '🥩 <b>Мясник</b>' },
        { eventType: 'record_damage_received_match', recordType: 'damage_received_match', title: '🤕 <b>Груша для битья</b>' },
        { eventType: 'record_died_first_rounds', recordType: 'died_first_rounds_match', title: '🐴 <b>Троянский конь</b>' },
        { eventType: 'record_survived_last_rounds', recordType: 'survived_last_rounds_match', title: '⚓ <b>Якорь</b>' },
      ];

      seedUser(sqlite, 1, 'p1', { riotName: 'Chain', riotTag: 'CHN' });
      for (const c of cases) {
        seedAllTimeRecord(sqlite, { recordType: c.recordType, value: 0, puuid: 'p1' });
        for (const [i, value] of [10, 20].entries()) {
          const matchId = `${c.eventType}-${i}`;
          seedMatch(sqlite, { puuid: 'p1', matchId, startedAt: IN_WINDOW });
          seedEvent(sqlite, {
            puuid: 'p1', matchId, eventType: c.eventType,
            payload: { value }, detectedAt: IN_WINDOW + i,
          });
        }
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      for (const c of cases) {
        const hits = result.richHtml!.match(new RegExp(c.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
        expect(hits, c.eventType).toHaveLength(1);
      }
    });

    it('names both co-kings under ONE 👑 block, not two blocks', async () => {
      // A shared crown must be extra NAMES inside one award, never a second
      // award block — that would be the very duplicate the collapse prevents.
      seedUser(sqlite, 1, 'p-aa', { riotName: 'Ann', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p-zz', { riotName: 'Zed', riotTag: 'ZZZ' });
      seedMatch(sqlite, { puuid: 'p-aa', matchId: 'mvp-1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p-aa', matchId: 'weekly:mvp:2026-W19', eventType: 'record_mvp_count_week',
        payload: { value: 7, puuids: ['p-aa', 'p-zz'] }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!.match(/👑 <b>Король MVP за неделю<\/b>/g)).toHaveLength(1);
      expect(result.richHtml!).toContain('<b>Ann#AAA</b> · 7 MVP-матчей');
      expect(result.richHtml!).toContain('<b>Zed#ZZZ</b> · 7 MVP-матчей');
    });

    it('drops an opted-out co-king but keeps the award for the rest', async () => {
      seedUser(sqlite, 1, 'p-aa', { riotName: 'Ann', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p-zz', { riotName: 'Zed', riotTag: 'ZZZ' });
      seedOptOut(sqlite, 2, 1);
      seedMatch(sqlite, { puuid: 'p-aa', matchId: 'mvp-1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p-aa', matchId: 'weekly:mvp:2026-W19', eventType: 'record_mvp_count_week',
        payload: { value: 7, puuids: ['p-aa', 'p-zz'] }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('<b>Ann#AAA</b>');
      expect(result.richHtml!).not.toContain('Zed#ZZZ');
    });

    it('an opted-out FIRST holder no longer takes the co-king down too', async () => {
      seedUser(sqlite, 1, 'p-aa', { riotName: 'Ann', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p-zz', { riotName: 'Zed', riotTag: 'ZZZ' });
      seedOptOut(sqlite, 1, 1);
      seedMatch(sqlite, { puuid: 'p-aa', matchId: 'mvp-1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p-aa', matchId: 'weekly:mvp:2026-W19', eventType: 'record_mvp_count_week',
        payload: { value: 7, puuids: ['p-aa', 'p-zz'] }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('👑 <b>Король MVP за неделю</b>');
      expect(result.richHtml!).toContain('<b>Zed#ZZZ</b>');
      expect(result.richHtml!).not.toContain('Ann#AAA');
    });

    it('gives a player one winstreak line even with two events in the window', async () => {
      // The detector dedups per ISO week; the digest window is a rolling Fri→Fri
      // seven days that straddles two ISO weeks, so one player on a long run
      // legitimately has two events — and used to get two lines.
      seedUser(sqlite, 1, 'p1', { riotName: 'Streaker', riotTag: 'STK' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'ws-1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'ws-1', eventType: 'winstreak_10plus',
        payload: { streak: 10 }, detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'ws-2', eventType: 'winstreak_10plus',
        payload: { streak: 13 }, detectedAt: IN_WINDOW + 1,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!.match(/<b>Streaker#STK<\/b> · \d+ побед подряд/g)).toHaveLength(1);
      expect(result.richHtml!).toContain('13 побед подряд');
    });

    it('still lists two different players on a winstreak', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'One', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Two', riotTag: 'BBB' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'ws-1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'ws-1', eventType: 'winstreak_10plus',
        payload: { streak: 10 }, detectedAt: IN_WINDOW,
      });
      seedEvent(sqlite, {
        puuid: 'p2', matchId: 'ws-2', eventType: 'winstreak_10plus',
        payload: { streak: 11 }, detectedAt: IN_WINDOW + 1,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('<b>One#AAA</b> · 10 побед подряд');
      expect(result.richHtml!).toContain('<b>Two#BBB</b> · 11 побед подряд');
    });

    it('names both players when «Больше всех матчей» is tied', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      seedUser(sqlite, 2, 'p2', { riotName: 'Beta', riotTag: 'BBB' });
      seedUser(sqlite, 3, 'p3', { riotName: 'Gamma', riotTag: 'GGG' });
      for (let i = 0; i < 6; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `a-${i}`, startedAt: IN_WINDOW });
        seedMatch(sqlite, { puuid: 'p2', matchId: `b-${i}`, startedAt: IN_WINDOW });
      }
      for (let i = 0; i < 5; i++) {
        seedMatch(sqlite, { puuid: 'p3', matchId: `c-${i}`, startedAt: IN_WINDOW });
      }

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).toContain('<b>Alpha#AAA</b> · 6 за неделю');
      expect(result.richHtml!).toContain('<b>Beta#BBB</b> · 6 за неделю');
      // Only the winning count is crowned — the runner-up stays out.
      expect(result.richHtml!).not.toContain('<b>Gamma#GGG</b> · 5 за неделю');
      expect(result.richHtml!.match(/🏆 <b>Больше всех матчей<\/b>/g)).toHaveLength(1);
    });
  });

  describe('richHtml rendering (#315)', () => {
    it('richHtml is null exactly when text is null (empty week)', async () => {
      seedUser(sqlite, 1, 'p1');
      seedMatch(sqlite, { puuid: 'p1', startedAt: OUT_OF_WINDOW });
      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.text).toBeNull();
      expect(result.richHtml).toBeNull();
    });

    it('richHtml has the <h2> title, cover img, pulse, <footer>#digest</footer>, and no raw newline', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Alpha', riotTag: 'AAA' });
      for (let i = 0; i < 3; i++) {
        seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'Ascent', agent: 'Jett' });
      }
      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('<h2>📅 Дайджест за неделю');
      // Cover = splash of the week's top map (Ascent).
      expect(html).toContain(
        '<img src="https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png">',
      );
      expect(html).toContain('📊 За неделю мы сыграли <b>3</b> матчей');
      expect(html.endsWith('<footer>#digest</footer>')).toBe(true);
      // Rich HTML must carry no raw newline — every break is <br> or block markup.
      expect(html).not.toContain('\n');
    });

    it('omits the cover img when the top map is unknown to the splash table', async () => {
      seedUser(sqlite, 1, 'p1');
      // "District" has a local-asset gap / is not in the splash table → no cover.
      for (let i = 0; i < 3; i++) seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'District', agent: 'Jett' });
      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      expect(result.richHtml!).not.toContain('<img');
    });

    it('renders maps and agents as full leaderboard blocks (no tables, no top-3)', async () => {
      seedUser(sqlite, 1, 'p1');
      for (let i = 0; i < 4; i++) seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + i * 1000, map: 'Ascent', agent: 'Jett' });
      for (let i = 0; i < 2; i++) seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW + (i + 10) * 1000, map: 'Bind', agent: 'Sage' });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      // Maps: icon + name. Agents: icon alone.
      expect(html).toContain('🗺 <b>Карты недели</b><br><br>🥇 <tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> Ascent — 4');
      expect(html).toContain('🎭 <b>Агенты недели</b><br><br>🥇 <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> — 4');
      expect(html).not.toContain('🦸</tg-emoji> Jett —');
      expect(html).not.toContain('<table');
      expect(html).not.toContain('align="right"');
    });

    it('renders «Мастера своего дела» as flat lines with weapon/frags/player (no table)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Sniper', riotTag: 'SNP' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'kpw-m1', startedAt: IN_WINDOW });
      // Sheriff is in DIGEST_ALLOWED_WEAPONS (Vandal/Phantom are deliberately excluded).
      seedEvent(sqlite, {
        puuid: 'p1',
        matchId: 'kpw-m1#kpw-Sheriff',
        eventType: 'record_kills_per_weapon',
        payload: { weapon: 'Sheriff', value: 22, real_match_id: 'kpw-m1' },
        detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('🔫 <b>Мастера своего дела</b>');
      // Sheriff weapon emoji id from valorant-emoji.ts; one line per weapon.
      expect(html).toContain('<tg-emoji emoji-id="5265082472659459467">🔫</tg-emoji> Sheriff · 22 — <b>Sniper#SNP</b>');
      expect(html).not.toContain('<table');
      // The text twin carries the same section — both come from one model.
      expect(result.text).toContain('🔫 <b>Мастера своего дела</b>');
      expect(result.text).toContain('Sheriff · 22 — <b>Sniper#SNP</b>');
    });

    it('renders each record as two flat lines: title, then rank+agent nick · value · match link', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 20, puuid: 'p-holder', matchId: 'old-kills' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      // The record's own match carries the player's rank (Diamond 3 → 💎) + agent (Jett → 🦸).
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm-kills', startedAt: IN_WINDOW, kills: 38, agent: 'Jett', map: 'Ascent', rankAfter: 'Diamond 3' });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'm-kills', eventType: 'record_kills_match',
        payload: { value: 38 }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain(
        '💀 <b>Серийный маньяк</b><br><br>' +
          '<tg-emoji emoji-id="5265219666799795636">💎</tg-emoji> <b>Killer#KLL</b> <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji>' +
          ' · 38 фрагов · ' +
          '<tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> <a href="https://tracker.gg/valorant/match/m-kills">Ascent</a>',
      );
      // The accordion (and with it the per-record context line) is gone.
      expect(html).not.toContain('<details>');
      expect(html).not.toContain('рекорд по количеству фрагов за игру');
      expect(html).not.toContain('\n');
    });

    it('omits the rank emoji from a record when rank_after is absent for that match', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 20, puuid: 'p-holder', matchId: 'old-kills' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Killer', riotTag: 'KLL' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'm-kills', startedAt: IN_WINDOW, kills: 38, agent: 'Jett', map: 'Ascent' });
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'm-kills', eventType: 'record_kills_match',
        payload: { value: 38 }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      // Nick with agent but NO leading rank emoji.
      expect(html).toContain('<br><br><b>Killer#KLL</b> <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> · 38 фрагов');
      expect(html).not.toContain('💎');
    });

    it('renders the winstreak card without <details> and without a match link', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Streaker', riotTag: 'STR' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, { puuid: 'p1', eventType: 'winstreak_10plus', payload: { streak: 11 }, detectedAt: IN_WINDOW });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('🏆 <b>Винстрик недели</b><br><br><b>Streaker#STR</b> · 11 побед подряд');
      expect(html).not.toContain('<summary>🏆 <b>Винстрик');
      expect(html).not.toContain('\n');
    });

    it('renders promotions as flat «ник → ранг» lines with the rank emoji (no table)', async () => {
      seedUser(sqlite, 1, 'p1', { riotName: 'Climber', riotTag: 'UP' });
      seedMatch(sqlite, { puuid: 'p1', startedAt: IN_WINDOW });
      seedEvent(sqlite, {
        puuid: 'p1', eventType: 'peak_rank_up',
        payload: { to_tier_name: 'Platinum 1' }, detectedAt: IN_WINDOW,
      });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('🎖 <b>Повышение по службе</b>');
      // Platinum 1 → 🐳 (tier 15).
      expect(html).toContain('<b>Climber#UP</b> → <tg-emoji emoji-id="5264763678711913942">🐳</tg-emoji>');
      expect(html).not.toContain('<table');
      expect(html).not.toContain('\n');
    });

    it('renders near-miss as OPEN blocks (not a <details>) with renderPlayerName and value', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'kills_match', value: 30, puuid: 'p-holder', matchId: 'old-kills' });
      seedUser(sqlite, 1, 'p1', { riotName: 'NearMisser', riotTag: 'NM' });
      seedMatch(sqlite, { puuid: 'p1', matchId: 'nm-match', startedAt: IN_WINDOW, kills: 29, agent: 'Jett' });

      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).not.toContain('<details><summary>💨');
      // OPEN block: emoji <u>header</u><br>renderPlayerName · value; agent rides along.
      expect(html).toContain(
        '💀 <u>Был(ла) близко к рекорду по киллам</u><br><br><b>NearMisser#NM</b> <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> · 29 фрагов',
      );
      expect(html).not.toContain('\n');
    });

    it('renders the Король MVP aggregate record with no match link, no agent, no rank', async () => {
      seedUser(sqlite, 99, 'p-holder', { riotName: 'Holder', riotTag: 'HLD' });
      seedAllTimeRecord(sqlite, { recordType: 'mvp_count_week', value: 3, puuid: 'p-holder', matchId: 'old-mvp' });
      seedUser(sqlite, 1, 'p1', { riotName: 'Chief', riotTag: 'MVP' });
      // 5 MVP matches this week beats the all-time 3.
      for (let i = 0; i < 5; i++) {
        seedMatch(sqlite, { puuid: 'p1', matchId: `mvp-${i}`, startedAt: IN_WINDOW + i * 1000, isMatchMvp: 1, agent: 'Jett' });
      }
      // Seed the bright record event (as computeAndEmitWeeklyMvpRecord would in
      // production — its own detected_at=weekEnd is excluded by the < window).
      seedEvent(sqlite, {
        puuid: 'p1', matchId: 'mvp-0', eventType: 'record_mvp_count_week',
        payload: { value: 5, prev_value: 3 }, detectedAt: IN_WINDOW,
      });
      const result = await buildDigest({ db, weekStart: WEEK_START, weekEnd: WEEK_END });
      const html = result.richHtml!;
      expect(html).toContain('👑 <b>Король MVP за неделю</b><br><br><b>Chief#MVP</b> · 5 MVP-матчей');
      // Aggregate → its value line carries no match <a> link. The block runs
      // from the title up to the next blank-line separator.
      const mvpIdx = html.indexOf('👑 <b>Король MVP');
      const sepIdx = html.indexOf('<br><br>', mvpIdx);
      const mvpBlock = html.slice(mvpIdx, sepIdx === -1 ? undefined : sepIdx);
      expect(mvpBlock).not.toContain('<a href');
      expect(html).not.toContain('\n');
    });
  });
});
