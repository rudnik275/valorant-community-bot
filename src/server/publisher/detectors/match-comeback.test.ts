import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { matchComebackDetector } from './match-comeback.ts';
import { matchRosters } from '../../db/schema/match_rosters.ts';
import { users } from '../../db/schema/users.ts';
import { detectedEvents } from '../../db/schema/detected_events.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const BASE_RECORD: MatchRecord = {
  riot_puuid: 'puuid-1',
  match_id: 'match-comeback-001',
  started_at: 1747000000000,
  map: 'Ascent',
  agent: 'Jett',
  kills: 20,
  deaths: 15,
  assists: 5,
  result: 'win',
  rounds_played: 24,
  rank_before: null,
  rank_after: 'Diamond 1',
  enemy_avg_rank: 'Diamond 1',
  fall_damage_kills: 0,
  kill_events_compact: '[]',
  rounds_compact: null,
  per_round_afk_compact: null,
  score: null,
  headshots: null,
  bodyshots: null,
  legshots: null,
  damage_dealt: null,
  damage_received: null,
  team_rounds_won: 13,
  team_rounds_lost: 11,
  game_length_ms: null,
  is_match_mvp: null,
  survived_last_rounds: null,  died_first_rounds: null,  inserted_at: 1747000000000,
};

/**
 * Build rounds_compact JSON simulating a comeback match.
 */
function makeRoundsCompact(blueWins: number[], redWins: number[]): string {
  const rounds = [
    ...blueWins.map((r) => ({ r, w: 'Blue' })),
    ...redWins.map((r) => ({ r, w: 'Red' })),
  ].sort((a, b) => a.r - b.r);
  return JSON.stringify(rounds);
}

async function seedUser(db: ReturnType<typeof makeTestDb>['db'], puuid: string, name: string, tag: string) {
  await db.insert(users).values({
    telegram_id: Math.floor(Math.random() * 1_000_000),
    riot_puuid: puuid,
    riot_name: name,
    riot_tag: tag,
  });
}

async function seedRoster(
  db: ReturnType<typeof makeTestDb>['db'],
  matchId: string,
  puuid: string,
  team: string,
) {
  await db.insert(matchRosters).values({ match_id: matchId, riot_puuid: puuid, team });
}

describe('matchComebackDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('emits when team had exactly 8-round deficit and won 13:11', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');

    // Walk: B,B,R,R,R,R,R,R,R,R,R,R,B,...
    // Round 12: Blue=2, Red=10 → only deficit point ≥ 8 → displayed.
    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('match_comeback');
    expect(events[0]!.payload.max_deficit).toBe(8);
    // Single deficit-≥8 point: round 12 (Blue=2, Red=10).
    expect(events[0]!.payload.deficit_score_player).toBe(2);
    expect(events[0]!.payload.deficit_score_opponent).toBe(10);
    expect(events[0]!.payload.final_score_player).toBe(13);
    expect(events[0]!.payload.final_score_opponent).toBe(11);
  });

  it('emits with max_deficit=10 when trailing 0:10 then won 13:11', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');

    const redWins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 24];
    const blueWins = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.max_deficit).toBe(10);
    expect(events[0]!.payload.deficit_score_player).toBe(0);
    expect(events[0]!.payload.deficit_score_opponent).toBe(10);
  });

  it('reports the max-gap point, not later qualifying points: 0:9 (gap 9) beats 3:11 (gap 8)', async () => {
    // Real-match regression for tracker match 779b0c65 (Breeze 16:14 OT).
    // The trajectory hits two deficit-≥8 points: 0:9 after round 9 (gap=9)
    // and 3:11 after round 14 (gap=8). The displayed score must be the
    // max-gap point (0:9), even though the opponent reaches match-point
    // (11/13) at the later, smaller-gap point.
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-779', 'puuid-1', 'A');

    const aWins = [10, 11, 12, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 27, 29, 30];
    const bWins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 19, 26, 28];
    const rounds = [
      ...aWins.map((r) => ({ r, w: 'A' })),
      ...bWins.map((r) => ({ r, w: 'B' })),
    ].sort((a, b) => a.r - b.r);
    const record: MatchRecord = {
      ...BASE_RECORD,
      match_id: 'match-779',
      rounds_compact: JSON.stringify(rounds),
      per_round_afk_compact: null,
      team_rounds_won: 16,
      team_rounds_lost: 14,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.max_deficit).toBe(9);
    expect(events[0]!.payload.deficit_score_player).toBe(0);
    expect(events[0]!.payload.deficit_score_opponent).toBe(9);
    expect(events[0]!.payload.final_score_player).toBe(16);
    expect(events[0]!.payload.final_score_opponent).toBe(14);
  });

  it('does NOT emit when max deficit was only 7', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');

    const blueWins2 = [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const redWins2 = [2, 3, 4, 5, 6, 7, 8, 9];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins2, redWins2),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 8,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when result is loss', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Red');

    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22, 23, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      result: 'loss',
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 11,
      team_rounds_lost: 13,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when rounds_compact is null (older match)', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: null,
      per_round_afk_compact: null,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when rounds_compact is empty array', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: '[]',
      per_round_afk_compact: null,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when team_rounds_won does not match any team count (corrupt data)', async () => {
    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 99,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('handles invalid JSON in rounds_compact gracefully', async () => {
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: 'not-valid-json',
      per_round_afk_compact: null,
    };
    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });

  it('idempotency: ran twice → only first call emits (detected_events guard)', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');

    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };

    const firstEvents = await matchComebackDetector.detect(record, [], { db });
    expect(firstEvents).toHaveLength(1);

    await db.insert(detectedEvents).values({
      event_type: 'match_comeback',
      riot_puuid: 'puuid-1',
      match_id: 'match-comeback-001',
      payload_json: JSON.stringify(firstEvents[0]!.payload),
    });

    const secondEvents = await matchComebackDetector.detect(record, [], { db });
    expect(secondEvents).toHaveLength(0);
  });

  it('grouping: multiple community members on winning team → all in community_players', async () => {
    await seedUser(db, 'puuid-1', 'Winner1', 'T1');
    await seedUser(db, 'puuid-2', 'Winner2', 'T2');
    await seedUser(db, 'puuid-3', 'Winner3', 'T3');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-comeback-001', 'puuid-2', 'Blue');
    await seedRoster(db, 'match-comeback-001', 'puuid-3', 'Blue');

    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };

    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(1);
    const players = events[0]!.payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>;
    expect(players).toHaveLength(3);
    const puuids = players.map((p) => p.puuid).sort();
    expect(puuids).toEqual(['puuid-1', 'puuid-2', 'puuid-3']);
  });

  it('grouping: community members on enemy (losing) team excluded from payload', async () => {
    await seedUser(db, 'puuid-1', 'Winner1', 'T1');
    await seedUser(db, 'puuid-2', 'Winner2', 'T2');
    await seedUser(db, 'puuid-3', 'Loser1',  'T3');
    await seedUser(db, 'puuid-4', 'Loser2',  'T4');
    await seedRoster(db, 'match-comeback-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-comeback-001', 'puuid-2', 'Blue');
    await seedRoster(db, 'match-comeback-001', 'puuid-3', 'Red');
    await seedRoster(db, 'match-comeback-001', 'puuid-4', 'Red');

    const blueWins = [1, 2, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
    const redWins = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24];
    const record: MatchRecord = {
      ...BASE_RECORD,
      rounds_compact: makeRoundsCompact(blueWins, redWins),
      per_round_afk_compact: null,
      team_rounds_won: 13,
      team_rounds_lost: 11,
    };

    const events = await matchComebackDetector.detect(record, [], { db });
    expect(events).toHaveLength(1);
    const players = events[0]!.payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>;
    expect(players).toHaveLength(2);
    const puuids = players.map((p) => p.puuid).sort();
    expect(puuids).toEqual(['puuid-1', 'puuid-2']);
  });
});
