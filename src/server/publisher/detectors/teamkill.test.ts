import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { join } from 'node:path';
import { teamkillDetector } from './teamkill.ts';
import type { MatchRecord } from '../types.ts';
import { users } from '../../db/schema/users.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const ATTACKER_PUUID = 'puuid-attacker';
const VICTIM_PUUID = 'puuid-victim';
const VICTIM2_PUUID = 'puuid-victim2';
const RANDOM_PUUID = 'puuid-random-outsider';

function makeRecord(killEventsCompact: string): MatchRecord {
  return {
    riot_puuid: ATTACKER_PUUID,
    match_id: 'match-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Omen',
    kills: 10,
    deaths: 8,
    assists: 3,
    result: 'win',
    rounds_played: 24,
    rank_before: null,
    rank_after: 'Gold 3',
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: killEventsCompact,
    rounds_compact: null,
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
    inserted_at: 1750000000000,
  };
}

function makeKill(
  round: number,
  attacker: string,
  victim: string,
  attackerTeam: string,
  victimTeam: string,
  weapon = 'Vandal',
) {
  return { round, attacker_team: attackerTeam, victim_team: victimTeam, weapon, attacker_puuid: attacker, victim_puuid: victim };
}

async function seedUser(db: ReturnType<typeof makeTestDb>['db'], telegramId: number, puuid: string, name: string, tag: string) {
  await db.insert(users).values({
    telegram_id: telegramId,
    riot_puuid: puuid,
    riot_name: name,
    riot_tag: tag,
  });
}

describe('teamkillDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(async () => {
    ({ db, sqlite } = makeTestDb());
    // Seed the attacker as a community member
    await seedUser(db, 1001, ATTACKER_PUUID, 'Attacker', 'EUW');
  });

  afterEach(() => {
    sqlite.close();
  });

  it('both in users — emits event with victim name in payload', async () => {
    await seedUser(db, 1002, VICTIM_PUUID, 'VictimNick', 'RU1');
    const record = makeRecord(JSON.stringify([
      makeKill(3, ATTACKER_PUUID, VICTIM_PUUID, 'Blue', 'Blue'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('teamkill');
    expect(events[0]!.payload.round_numbers).toEqual([3]);
    expect(events[0]!.payload.victim_names_for_template).toEqual(['VictimNick']);
    const victims = events[0]!.payload.victims as Array<{ puuid: string; name: string; tag: string }>;
    expect(victims).toHaveLength(1);
    expect(victims[0]!.puuid).toBe(VICTIM_PUUID);
    expect(victims[0]!.name).toBe('VictimNick');
    expect(victims[0]!.tag).toBe('RU1');
  });

  it('attacker in users, victim NOT in users — no event', async () => {
    // RANDOM_PUUID is not seeded into users
    const record = makeRecord(JSON.stringify([
      makeKill(5, ATTACKER_PUUID, RANDOM_PUUID, 'Blue', 'Blue'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('attacker with unknown puuid kills community victim — emits event (attacker row not required)', async () => {
    await seedUser(db, 1002, VICTIM_PUUID, 'VictimNick', 'RU1');
    const record: MatchRecord = { ...makeRecord(JSON.stringify([
      makeKill(3, 'ghost-puuid', VICTIM_PUUID, 'Blue', 'Blue'),
    ])), riot_puuid: 'ghost-puuid' };
    // The detector filters k.attacker_puuid === record.riot_puuid, so ghost-puuid kills will be found.
    // Victim IS in users, so event fires. (Attacker does not need a users row.)
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(1);
  });

  it('2 different victims: 1 community + 1 random — emits event with only the community victim', async () => {
    await seedUser(db, 1002, VICTIM_PUUID, 'CommunityMember', 'EU1');
    // RANDOM_PUUID not seeded
    const record = makeRecord(JSON.stringify([
      makeKill(3, ATTACKER_PUUID, VICTIM_PUUID, 'Blue', 'Blue'),
      makeKill(7, ATTACKER_PUUID, RANDOM_PUUID, 'Blue', 'Blue'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.round_numbers).toEqual([3]);
    expect(events[0]!.payload.victim_names_for_template).toEqual(['CommunityMember']);
  });

  it('2 community victims in different rounds — emits ONE event with both in payload', async () => {
    await seedUser(db, 1002, VICTIM_PUUID, 'Victim1', 'RU1');
    await seedUser(db, 1003, VICTIM2_PUUID, 'Victim2', 'RU2');
    const record = makeRecord(JSON.stringify([
      makeKill(2, ATTACKER_PUUID, VICTIM_PUUID, 'Blue', 'Blue'),
      makeKill(8, ATTACKER_PUUID, VICTIM2_PUUID, 'Blue', 'Blue'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.round_numbers).toEqual([2, 8]);
    const names = events[0]!.payload.victim_names_for_template as string[];
    expect(names).toContain('Victim1');
    expect(names).toContain('Victim2');
    expect(names).toHaveLength(2);
  });

  it('self-kill (attacker === victim, same team) — no event', async () => {
    const record = makeRecord(JSON.stringify([
      makeKill(5, ATTACKER_PUUID, ATTACKER_PUUID, 'Blue', 'Blue'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('normal kill (different team) — no event', async () => {
    await seedUser(db, 1002, VICTIM_PUUID, 'Enemy', 'EN1');
    const record = makeRecord(JSON.stringify([
      makeKill(4, ATTACKER_PUUID, VICTIM_PUUID, 'Blue', 'Red'),
      makeKill(6, ATTACKER_PUUID, VICTIM_PUUID, 'Blue', 'Red'),
    ]));
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('no kills at all — no event', async () => {
    const record = makeRecord('[]');
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('null riot_puuid — no event', async () => {
    const record: MatchRecord = { ...makeRecord('[]'), riot_puuid: null as unknown as string };
    const events = await teamkillDetector.detectAsync!(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
