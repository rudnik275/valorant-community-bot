import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordKillsPerWeaponDetector } from './record-kills-per-weapon.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;'); // allow orphan rows without users table
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function makeKillEvent(overrides: {
  weapon?: string;
  attacker_puuid?: string;
  victim_puuid?: string;
} = {}) {
  return {
    round: 1,
    weapon: overrides.weapon ?? 'Operator',
    attacker_puuid: overrides.attacker_puuid ?? 'puuid-test',
    victim_puuid: overrides.victim_puuid ?? 'puuid-victim',
    attacker_team: 'Blue',
    victim_team: 'Red',
  };
}

function makeRecord(overrides: Partial<MatchRecord> & { killEvents?: object[] } = {}): MatchRecord {
  const { killEvents, ...rest } = overrides;
  return {
    riot_puuid: 'puuid-test',
    match_id: 'match-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 10,
    deaths: 5,
    assists: 1,
    result: 'win',
    rounds_played: 15,
    rank_before: null,
    rank_after: 'Diamond 1',
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: killEvents !== undefined ? JSON.stringify(killEvents) : '[]',
    rounds_compact: null,
    per_round_afk_compact: null,
    score: null,
    headshots: null,
    bodyshots: null,
    legshots: null,
    damage_dealt: null,
    damage_received: null,
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    survived_last_rounds: null,    died_first_rounds: null,    inserted_at: 1750000000000,
    ...rest,
  };
}

describe('recordKillsPerWeaponDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('no kills in match → no events', async () => {
    const record = makeRecord({ killEvents: [] });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null riot_puuid → no events', async () => {
    const record = makeRecord({
      riot_puuid: null as unknown as string,
      killEvents: [makeKillEvent({ attacker_puuid: 'null', weapon: 'Operator' })],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('invalid kill_events_compact JSON → no events', async () => {
    const record = makeRecord();
    (record as { kill_events_compact: string }).kill_events_compact = 'NOT_JSON';
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('all kills with excluded weapons (Vandal, Phantom, Knife, Fall) → no events', async () => {
    const record = makeRecord({
      killEvents: [
        makeKillEvent({ weapon: 'Vandal' }),
        makeKillEvent({ weapon: 'Phantom' }),
        makeKillEvent({ weapon: 'Knife' }),
        makeKillEvent({ weapon: 'Fall' }),
        makeKillEvent({ weapon: '9c82e19d-4575-0200-1a81-3eacf00cf872' }), // Vandal UUID
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('single weapon, first time (no existing record) → NO event emitted (skip first-time flood)', async () => {
    const record = makeRecord({
      killEvents: [
        makeKillEvent({ weapon: 'Operator' }),
        makeKillEvent({ weapon: 'Operator' }),
        makeKillEvent({ weapon: 'Operator' }),
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    // First-time record: beaten=true but prev is null → no event
    expect(events).toHaveLength(0);
  });

  it('single weapon beats existing record → event emitted with correct fields', async () => {
    const puuid = 'puuid-test';

    // Seed initial record via first pass (won't emit — first-time)
    const firstRecord = makeRecord({
      match_id: 'match-first',
      riot_puuid: 'puuid-other',
      killEvents: [
        makeKillEvent({ weapon: 'Operator', attacker_puuid: 'puuid-other' }),
        makeKillEvent({ weapon: 'Operator', attacker_puuid: 'puuid-other' }),
      ],
    });
    await recordKillsPerWeaponDetector.detect(firstRecord, [], { db });

    // Now beat it with our player
    const beatRecord = makeRecord({
      match_id: 'match-beat',
      riot_puuid: puuid,
      killEvents: [
        makeKillEvent({ weapon: 'Operator', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Operator', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Operator', attacker_puuid: puuid }),
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(beatRecord, [], { db });

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('record_kills_per_weapon');
    expect(ev.riot_puuid).toBe(puuid);
    expect(ev.payload['weapon']).toBe('Operator');
    expect(ev.payload['value']).toBe(3);
    expect(ev.payload['prev_value']).toBe(2);
    expect(ev.payload['real_match_id']).toBe('match-beat');
    // Synthetic match_id for dedup
    expect(ev.match_id).toBe('match-beat#kpw-Operator');
  });

  it('2 weapons both beat existing records → 2 events with distinct synthetic match_ids', async () => {
    const puuid = 'puuid-test';

    // Seed initial records for Operator and Marshal via a different player
    const seedRecord = makeRecord({
      match_id: 'match-seed',
      riot_puuid: 'puuid-seed',
      killEvents: [
        makeKillEvent({ weapon: 'Operator', attacker_puuid: 'puuid-seed' }),
        makeKillEvent({ weapon: 'Marshal', attacker_puuid: 'puuid-seed' }),
      ],
    });
    await recordKillsPerWeaponDetector.detect(seedRecord, [], { db });

    // Now beat both with our player
    const beatRecord = makeRecord({
      match_id: 'match-beat-multi',
      riot_puuid: puuid,
      killEvents: [
        makeKillEvent({ weapon: 'Operator', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Operator', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Marshal', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Marshal', attacker_puuid: puuid }),
        makeKillEvent({ weapon: 'Marshal', attacker_puuid: puuid }),
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(beatRecord, [], { db });

    expect(events).toHaveLength(2);
    const matchIds = events.map((e) => e.match_id);
    expect(matchIds).toContain('match-beat-multi#kpw-Operator');
    expect(matchIds).toContain('match-beat-multi#kpw-Marshal');

    // All real_match_ids should reference the real match
    for (const ev of events) {
      expect(ev.payload['real_match_id']).toBe('match-beat-multi');
    }
  });

  it('drops Vandal kills (intentionally excluded — too dominant)', async () => {
    const record = makeRecord({
      killEvents: [makeKillEvent({ weapon: 'Vandal' })],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('drops Phantom kills (intentionally excluded — too dominant)', async () => {
    const record = makeRecord({
      killEvents: [makeKillEvent({ weapon: 'Phantom' })],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('drops kills with empty weapon string', async () => {
    const record = makeRecord({
      killEvents: [makeKillEvent({ weapon: '' }), makeKillEvent({ weapon: '' })],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('drops kills whose weapon is a raw UUID (not in whitelist)', async () => {
    const record = makeRecord({
      killEvents: [
        makeKillEvent({ weapon: '39099fb5-4293-def4-1e09-2e9080ce7456' }),
        makeKillEvent({ weapon: '39099fb5-4293-def4-1e09-2e9080ce7456' }),
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('drops agent ability kills (Curveball, Showstopper, Hunter\'s Fury, TURRET)', async () => {
    // These are real names Henrik returns for ability kills — but they are
    // not weapons and the user does not want them in the digest records.
    const abilities = ['Curveball', 'Showstopper', "Hunter's Fury", 'TURRET', 'Blade Storm', 'Sky Smoke', 'Special Delivery'];
    for (const ability of abilities) {
      const record = makeRecord({
        match_id: `m-${ability}`,
        killEvents: [makeKillEvent({ weapon: ability })],
      });
      const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
      expect(events, `${ability} should be filtered out`).toHaveLength(0);
    }
  });

  it('only counts kills where attacker_puuid matches the community player', async () => {
    const puuid = 'puuid-test';
    const seedPuuid = 'puuid-seed';

    // Seed a record for Operator via seed player
    const seedRecord = makeRecord({
      match_id: 'match-seed',
      riot_puuid: seedPuuid,
      killEvents: [makeKillEvent({ weapon: 'Operator', attacker_puuid: seedPuuid })],
    });
    await recordKillsPerWeaponDetector.detect(seedRecord, [], { db });

    // Our player gets 0 Operator kills (all kills are by an enemy puuid)
    const record = makeRecord({
      match_id: 'match-zero',
      riot_puuid: puuid,
      killEvents: [
        makeKillEvent({ weapon: 'Operator', attacker_puuid: 'enemy-puuid' }),
        makeKillEvent({ weapon: 'Operator', attacker_puuid: 'enemy-puuid' }),
      ],
    });
    const events = await recordKillsPerWeaponDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
