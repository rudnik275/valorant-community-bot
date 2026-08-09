/**
 * records-rebuild.test.ts — Unit tests for clearDerivedRecords + rebuildAllRecords.
 *
 * Real SQLite (:memory:), PRAGMA foreign_keys=ON.
 * Scenario: departed player holds top records; after purge+rebuild, record belongs to
 * best remaining member (or is absent when no surviving data).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { rebuildAllRecords, clearDerivedRecords } from './records-rebuild.ts';
import { purgePlayer } from '../db/purge-player.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('records-rebuild', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  it('clearDerivedRecords removes all all_time_records and weekly_records', async () => {
    // Seed two users
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid) VALUES (1, 'puuid-a'), (2, 'puuid-b')`);
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('kills_match', '', 'puuid-a', 20, 'match-a', 1000), ('deaths_match', '', 'puuid-b', 10, 'match-b', 1001)`);
    sqlite.exec(`INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES ('mvp_count_week', '2024-W01', 'puuid-a', 2)`);

    await clearDerivedRecords(db);

    expect(sqlite.prepare(`SELECT * FROM all_time_records`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM weekly_records`).all()).toHaveLength(0);
  });

  it('rebuildAllRecords re-attributes kills record to best remaining player after purge', async () => {
    // Departed player (top kills=25)
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-departed', 'GonePlayer', 'GP')`);
    // Remaining player (kills=18)
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (2, 'puuid-remaining', 'HerePlayer', 'HP')`);

    // Departed holds the top kills record
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-departed', 'match-d1', 1000, 'Ascent', 'Jett', 25, 5, 2, 'win', 25, '[]')`);
    // Remaining player has a lower score
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-remaining', 'match-r1', 1001, 'Bind', 'Sage', 18, 7, 3, 'win', 25, '[]')`);

    // Purge the departed player
    await purgePlayer(db, { telegramId: 1, riotPuuid: 'puuid-departed' });

    // Rebuild records from surviving match_records
    await rebuildAllRecords(db);

    // The kills_match record should now belong to the remaining player
    const killsRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_match' AND weapon=''`).get() as { riot_puuid: string; value: number } | undefined;
    expect(killsRecord).toBeDefined();
    expect(killsRecord!.riot_puuid).toBe('puuid-remaining');
    expect(killsRecord!.value).toBe(18);
  });

  it('record type with no surviving data is absent (cleared, not stale)', async () => {
    // Only one player, holds the kills record
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-only', 'OnlyPlayer', 'OP')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-only', 'match-o1', 2000, 'Haven', 'Omen', 15, 4, 5, 'win', 25, '[]')`);

    // Seed a stale record pointing to this player
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('kills_match', '', 'puuid-only', 15, 'match-o1', 2000)`);

    // Purge the only player
    await purgePlayer(db, { telegramId: 1, riotPuuid: 'puuid-only' });

    // Rebuild — no match_records left
    await rebuildAllRecords(db);

    // kills_match should be absent (no surviving data)
    const killsRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_match'`).all();
    expect(killsRecord).toHaveLength(0);
  });

  it('weekly MVP record re-attributes to best remaining player after purge', async () => {
    const week = '2024-W10';
    const weekTs = new Date('2024-03-07T10:00:00+03:00').getTime(); // A Thursday in week 10

    // Departed had 3 MVPs, remaining had 1
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-mvp-gone', 'MVPGone', 'MG'), (2, 'puuid-mvp-here', 'MVPHere', 'MH')`);

    // Departed player — 3 MVP matches
    for (let i = 0; i < 3; i++) {
      sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, is_match_mvp, kill_events_compact) VALUES ('puuid-mvp-gone', 'match-mg${i}', ${weekTs + i}, 'Ascent', 'Jett', 10, 5, 2, 'win', 25, 1, '[]')`);
    }
    // Remaining player — 2 MVP matches
    for (let i = 0; i < 2; i++) {
      sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, is_match_mvp, kill_events_compact) VALUES ('puuid-mvp-here', 'match-mh${i}', ${weekTs + 10 + i}, 'Bind', 'Sage', 8, 6, 3, 'win', 25, 1, '[]')`);
    }

    // Purge departed
    await purgePlayer(db, { telegramId: 1, riotPuuid: 'puuid-mvp-gone' });

    // Rebuild
    await rebuildAllRecords(db);

    // Weekly MVP for that week should belong to remaining player
    const weeklyRecord = sqlite.prepare(`SELECT * FROM weekly_records WHERE record_type='mvp_count_week' AND week_iso='${week}'`).get() as { riot_puuid: string; value: number } | undefined;
    expect(weeklyRecord).toBeDefined();
    expect(weeklyRecord!.riot_puuid).toBe('puuid-mvp-here');
    expect(weeklyRecord!.value).toBe(2);
  });

  it('kills_per_weapon record re-attributes to best remaining player after purge', async () => {
    // Departed player had 5 Operator kills, remaining had 3
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-op-gone', 'OpGone', 'OG'), (2, 'puuid-op-here', 'OpHere', 'OH')`);

    // kill_events_compact with Operator kills for departed
    const departedKills = JSON.stringify([
      { round: 1, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-gone', victim_puuid: 'victim-1', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 2, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-gone', victim_puuid: 'victim-2', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 3, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-gone', victim_puuid: 'victim-3', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 4, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-gone', victim_puuid: 'victim-4', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 5, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-gone', victim_puuid: 'victim-5', attacker_team: 'Blue', victim_team: 'Red' },
    ]);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-op-gone', 'match-og', 3000, 'Split', 'Reyna', 5, 3, 1, 'win', 25, '${departedKills.replace(/'/g, "''")}')`);

    // kill_events_compact for remaining (3 Operator kills)
    const remainingKills = JSON.stringify([
      { round: 1, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-here', victim_puuid: 'victim-a', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 2, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-here', victim_puuid: 'victim-b', attacker_team: 'Blue', victim_team: 'Red' },
      { round: 3, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: 'puuid-op-here', victim_puuid: 'victim-c', attacker_team: 'Blue', victim_team: 'Red' },
    ]);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-op-here', 'match-oh', 3001, 'Icebox', 'Breach', 3, 4, 2, 'loss', 25, '${remainingKills.replace(/'/g, "''")}')`);

    // Purge departed
    await purgePlayer(db, { telegramId: 1, riotPuuid: 'puuid-op-gone' });

    // Rebuild
    await rebuildAllRecords(db);

    // kills_per_weapon for Operator should now be the remaining player
    const opRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_per_weapon' AND weapon='Operator'`).get() as { riot_puuid: string; value: number } | undefined;
    expect(opRecord).toBeDefined();
    expect(opRecord!.riot_puuid).toBe('puuid-op-here');
    expect(opRecord!.value).toBe(3);
  });

  it('rebuildAllRecords is idempotent — running twice gives same result', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-idem', 'IdemPlayer', 'IP')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-idem', 'match-i1', 5000, 'Sunset', 'Neon', 12, 6, 4, 'win', 25, '[]')`);

    await rebuildAllRecords(db);
    const afterFirst = sqlite.prepare(`SELECT * FROM all_time_records WHERE riot_puuid='puuid-idem'`).all();

    await rebuildAllRecords(db);
    const afterSecond = sqlite.prepare(`SELECT * FROM all_time_records WHERE riot_puuid='puuid-idem'`).all();

    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  it('a tied all-time record stays with the player who reached it first', async () => {
    // upsertRecord only ever replaces on a strict `>`, so live the first player
    // to hit 25 keeps the record forever. The rebuild had no secondary sort key,
    // so it handed the tie to whichever row SQLite happened to emit — here the
    // LATER match, because it was inserted first (owner, 2026-08-09).
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-late', 'LatePlayer', 'LP'), (2, 'puuid-early', 'EarlyPlayer', 'EP')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-late', 'match-late', 2000, 'Ascent', 'Jett', 25, 5, 2, 'win', 25, '[]')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-early', 'match-early', 1000, 'Bind', 'Sage', 25, 5, 2, 'win', 25, '[]')`);

    await rebuildAllRecords(db);

    const killsRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_match'`).get() as { riot_puuid: string; match_id: string; achieved_at: number };
    expect(killsRecord.riot_puuid).toBe('puuid-early');
    expect(killsRecord.match_id).toBe('match-early');
    expect(killsRecord.achieved_at).toBe(1000);
  });

  it('a tie inside one match is broken by puuid, not by row order', async () => {
    // Two teammates in the SAME match share started_at, so the earliest-first
    // key cannot separate them — without a third key the winner was scan order.
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-zz', 'Zed', 'ZZ'), (2, 'puuid-aa', 'Ann', 'AA')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-zz', 'match-shared', 4000, 'Haven', 'Raze', 22, 5, 2, 'win', 25, '[]')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-aa', 'match-shared', 4000, 'Haven', 'Omen', 22, 6, 3, 'win', 25, '[]')`);

    await rebuildAllRecords(db);

    const killsRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_match'`).get() as { riot_puuid: string };
    expect(killsRecord.riot_puuid).toBe('puuid-aa');
  });

  it('two rebuilds of the same data crown the same weekly MVP king', async () => {
    // The leader was picked by scanning a Map whose insertion order came from an
    // unordered SELECT, so on a tie the crown went to whoever the scan saw
    // first. The live weekly tick breaks the same tie with
    // `ORDER BY ... DESC, riot_puuid` — the rebuild has to agree with it.
    const week = '2024-W10';
    const weekTs = new Date('2024-03-07T10:00:00+03:00').getTime(); // a Thursday in week 10
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-zz', 'Zed', 'ZZ'), (2, 'puuid-aa', 'Ann', 'AA')`);
    for (let i = 0; i < 2; i++) {
      sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, is_match_mvp, kill_events_compact) VALUES ('puuid-zz', 'match-z${i}', ${weekTs + i}, 'Ascent', 'Jett', 10, 5, 2, 'win', 25, 1, '[]')`);
    }
    for (let i = 0; i < 2; i++) {
      sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, is_match_mvp, kill_events_compact) VALUES ('puuid-aa', 'match-a${i}', ${weekTs + 10 + i}, 'Bind', 'Sage', 8, 6, 3, 'win', 25, 1, '[]')`);
    }

    await rebuildAllRecords(db);

    const weeklyRecord = sqlite.prepare(`SELECT * FROM weekly_records WHERE record_type='mvp_count_week' AND week_iso='${week}'`).get() as { riot_puuid: string; value: number };
    expect(weeklyRecord.riot_puuid).toBe('puuid-aa');
    expect(weeklyRecord.value).toBe(2);
  });

  it('a tied kills_per_weapon record stays with the earliest match', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-late', 'LatePlayer', 'LP'), (2, 'puuid-early', 'EarlyPlayer', 'EP')`);
    const opKills = (puuid: string) => JSON.stringify([1, 2, 3].map((round) => ({
      round, weapon: '4ade7faa-4cf1-8376-95ef-39884480959b', attacker_puuid: puuid,
      victim_puuid: `victim-${round}`, attacker_team: 'Blue', victim_team: 'Red',
    })));
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-late', 'match-late', 2000, 'Split', 'Reyna', 3, 3, 1, 'win', 25, '${opKills('puuid-late')}')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact) VALUES ('puuid-early', 'match-early', 1000, 'Icebox', 'Breach', 3, 4, 2, 'loss', 25, '${opKills('puuid-early')}')`);

    await rebuildAllRecords(db);

    const opRecord = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='kills_per_weapon' AND weapon='Operator'`).get() as { riot_puuid: string; value: number };
    expect(opRecord.riot_puuid).toBe('puuid-early');
    expect(opRecord.value).toBe(3);
  });

  it('restores 🐴 Троянский конь and ⚓ Якорь instead of restarting them from zero', async () => {
    // These two were the only record types the rebuild wiped and never rebuilt,
    // so after any purge they restarted from nothing and every following match
    // set a «new record» — the 1 → 3 → 4 → 9 chain the group saw (owner,
    // 2026-08-09).
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-horse', 'Horse', 'TRJ'), (2, 'puuid-anchor', 'Anchor', 'ANC')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, died_first_rounds, survived_last_rounds, kill_events_compact) VALUES ('puuid-horse', 'match-h', 1000, 'Haven', 'Skye', 9, 9, 2, 'loss', 25, 9, 1, '[]')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, died_first_rounds, survived_last_rounds, kill_events_compact) VALUES ('puuid-anchor', 'match-a', 1001, 'Lotus', 'Sage', 12, 7, 4, 'win', 25, 2, 7, '[]')`);

    await rebuildAllRecords(db);

    const horse = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='died_first_rounds_match'`).get() as { riot_puuid: string; value: number; match_id: string };
    expect(horse.riot_puuid).toBe('puuid-horse');
    expect(horse.value).toBe(9);
    expect(horse.match_id).toBe('match-h');

    const anchor = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='survived_last_rounds_match'`).get() as { riot_puuid: string; value: number };
    expect(anchor.riot_puuid).toBe('puuid-anchor');
    expect(anchor.value).toBe(7);
  });

  it('an orphaned match with no owner cannot abort the rebuild', async () => {
    // The live chat-member listener deletes the users row directly, and the FK
    // is ON DELETE SET NULL, so the departed player's matches survive with a
    // NULL riot_puuid — rows the orphan sweep cannot match (NULL NOT IN (...)
    // is NULL). The damage/length backfills filtered only on their own column,
    // picked such a row as the winner and tried to write a NULL holder;
    // all_time_records.riot_puuid is NOT NULL, so the whole rebuild threw right
    // after clearDerivedRecords and left the group with no records at all.
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-gone', 'GonePlayer', 'GP'), (2, 'puuid-here', 'HerePlayer', 'HP')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, damage_dealt, damage_received, game_length_ms, kill_events_compact) VALUES ('puuid-gone', 'match-gone', 1000, 'Ascent', 'Jett', 20, 5, 2, 'win', 25, 9000, 8000, 3000000, '[]')`);
    sqlite.exec(`INSERT INTO match_records (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, damage_dealt, damage_received, game_length_ms, kill_events_compact) VALUES ('puuid-here', 'match-here', 1001, 'Bind', 'Sage', 10, 5, 2, 'win', 25, 3000, 2000, 1500000, '[]')`);
    sqlite.exec(`DELETE FROM users WHERE telegram_id = 1`);

    await expect(rebuildAllRecords(db)).resolves.toBeUndefined();

    const damage = sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='damage_dealt_match'`).get() as { riot_puuid: string; value: number };
    expect(damage.riot_puuid).toBe('puuid-here');
    expect(damage.value).toBe(3000);
    // Steps that run after the damage backfills must still have happened.
    expect(sqlite.prepare(`SELECT * FROM all_time_records WHERE record_type='longest_match_rounds'`).get()).toBeDefined();
  });
});
