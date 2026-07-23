/**
 * match-info.test.ts — resolveTemplateMatch against a real SQLite DB.
 *
 * The resolver is the SHARED data-plumbing seam between the realtime publisher
 * loop and the /test_runtime_events replay (#315 replay parity) — these tests
 * pin down exactly what template context each event gets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { resolveTemplateMatch } from './match-info.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

const MATCH = 'match-mi-1';
const KILLER = 'puuid-killer';
const VICTIM = 'puuid-victim';

describe('resolveTemplateMatch', () => {
  let sqlite: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys=OFF;');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedUser(id: number, puuid: string, name: string, tag: string) {
    sqlite.prepare(
      `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, puuid, name, tag, Date.now());
  }

  function seedMatchRecord(puuid: string, opts: { map?: string; agent?: string; rankAfter?: string | null } = {}) {
    sqlite.prepare(
      `INSERT INTO match_records
         (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
          rounds_played, rank_after, fall_damage_kills, kill_events_compact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      puuid, MATCH, 1_000, opts.map ?? 'Ascent', opts.agent ?? 'Jett',
      20, 10, 5, 'win', 24, opts.rankAfter ?? null, 0, '[]',
    );
  }

  function seedRosterRow(
    puuid: string,
    opts: { name?: string; tag?: string; agent?: string; tier?: string | null } = {},
  ) {
    sqlite.prepare(
      `INSERT INTO match_rosters (match_id, riot_puuid, team, name, tag, agent, tier, kills, deaths)
       VALUES (?, ?, 'Blue', ?, ?, ?, ?, 10, 10)`,
    ).run(MATCH, puuid, opts.name ?? 'Roster', opts.tag ?? 'RRR', opts.agent ?? 'Sage', opts.tier ?? null);
  }

  it('resolves map / agent / rank from the triggering player match_records row', async () => {
    seedMatchRecord(KILLER, { map: 'Bind', agent: 'Omen', rankAfter: 'Diamond 3' });
    const out = await resolveTemplateMatch(db, 'fall_damage_death', MATCH, KILLER, {});
    expect(out).toEqual({ map: 'Bind', match_id: MATCH, agent: 'Omen', rank: 'Diamond 3' });
  });

  it('omits rank when rank_after is NULL (graceful degradation)', async () => {
    seedMatchRecord(KILLER, { rankAfter: null });
    const out = await resolveTemplateMatch(db, 'return_after_pause', MATCH, KILLER, {});
    expect(out).toEqual({ map: 'Ascent', match_id: MATCH, agent: 'Jett' });
  });

  it('returns { match_id } only when no match_records row exists', async () => {
    const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {});
    expect(out).toEqual({ match_id: MATCH });
  });

  it('returns undefined when there is no match id at all', async () => {
    const out = await resolveTemplateMatch(db, 'teamkill', '', KILLER, {});
    expect(out).toBeUndefined();
  });

  it('record_kills_per_weapon: resolves via payload.real_match_id, not the synthetic id', async () => {
    seedMatchRecord(KILLER, { map: 'Icebox' });
    const out = await resolveTemplateMatch(
      db, 'record_kills_per_weapon', `${MATCH}#kpw-Vandal`, KILLER,
      { real_match_id: MATCH },
    );
    expect(out?.match_id).toBe(MATCH);
    expect(out?.map).toBe('Icebox');
  });

  describe('teamkill victims', () => {
    it('enriches payload victims with per-match rank (roster tier) by puuid', async () => {
      seedUser(2, VICTIM, 'Danya', 'UA1');
      seedMatchRecord(KILLER, { rankAfter: 'Gold 1' });
      seedRosterRow(VICTIM, { name: 'Danya', tag: 'UA1', agent: 'Sage', tier: 'Silver 2' });
      const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {
        victims: [{ puuid: VICTIM, name: 'Danya', tag: 'UA1', agent: 'Sage' }],
      });
      expect(out?.victims).toEqual([
        { name: 'Danya', tag: 'UA1', agent: 'Sage', rank: 'Silver 2' },
      ]);
    });

    it('fills tag/agent from the roster when the payload lacks them, matching legacy names by name', async () => {
      seedRosterRow(VICTIM, { name: 'OldGuy', tag: 'OLD', agent: 'Omen', tier: 'Iron 3' });
      const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {
        victim_names_for_template: ['OldGuy'],
      });
      expect(out?.victims).toEqual([
        { name: 'OldGuy', tag: 'OLD', agent: 'Omen', rank: 'Iron 3' },
      ]);
    });

    it('keeps payload data when no roster rows exist (no rank)', async () => {
      const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {
        victims: [{ puuid: VICTIM, name: 'Danya', tag: 'UA1', agent: 'Sage' }],
      });
      expect(out?.victims).toEqual([{ name: 'Danya', tag: 'UA1', agent: 'Sage' }]);
    });

    it('omits rank when the roster tier is NULL (pre-migration-0021 rows)', async () => {
      seedRosterRow(VICTIM, { name: 'Danya', tag: 'UA1', agent: 'Sage', tier: null });
      const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {
        victims: [{ puuid: VICTIM, name: 'Danya', tag: 'UA1', agent: 'Sage' }],
      });
      expect(out?.victims).toEqual([{ name: 'Danya', tag: 'UA1', agent: 'Sage' }]);
    });

    it('no victims key when the payload names nobody', async () => {
      const out = await resolveTemplateMatch(db, 'teamkill', MATCH, KILLER, {});
      expect(out?.victims).toBeUndefined();
    });

    it('non-teamkill events never get a victims key even with a victims payload', async () => {
      seedRosterRow(VICTIM, { tier: 'Gold 1' });
      const out = await resolveTemplateMatch(db, 'fall_damage_death', MATCH, KILLER, {
        victims: [{ puuid: VICTIM, name: 'Danya', tag: 'UA1' }],
      });
      expect(out?.victims).toBeUndefined();
    });
  });
});
