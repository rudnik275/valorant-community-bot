import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { communityClashDetector } from './community-clash.ts';
import { matchRosters } from '../../db/schema/match_rosters.ts';
import { users } from '../../db/schema/users.ts';
import { detectedEvents } from '../../db/schema/detected_events.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;'); // allow orphan rows without users table
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    riot_puuid: 'puuid-1',
    match_id: 'match-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 10,
    deaths: 5,
    assists: 2,
    result: 'win',
    rounds_played: 20,
    rank_before: null,
    rank_after: null,
    enemy_avg_rank: null,
    fall_damage_kills: 0,
    kill_events_compact: '[]',
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
    ...overrides,
  };
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
  name: string | null = null,
  tag: string | null = null,
) {
  await db.insert(matchRosters).values({ match_id: matchId, riot_puuid: puuid, team, name, tag });
}

describe('communityClashDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('2 community members on different teams → emits event with both teams in payload', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'win' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('community_clash');
    expect(events[0]!.match_id).toBe('match-001');
    const teams = events[0]!.payload['teams'] as Array<{ team_id: string; players: unknown[] }>;
    expect(teams).toHaveLength(2);
    const teamIds = teams.map((t) => t.team_id).sort();
    expect(teamIds).toEqual(['Blue', 'Red'].sort());
  });

  it('3 community on team A, 2 on team B → emits event (multiple per team allowed)', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedUser(db, `puuid-${i}`, `Player${i}`, `T${i}`);
    }
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-3', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-4', 'Red');
    await seedRoster(db, 'match-001', 'puuid-5', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'win' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    const teams = events[0]!.payload['teams'] as Array<{ team_id: string; players: unknown[] }>;
    expect(teams).toHaveLength(2);
    const blue = teams.find((t) => t.team_id === 'Blue');
    const red = teams.find((t) => t.team_id === 'Red');
    expect(blue?.players).toHaveLength(3);
    expect(red?.players).toHaveLength(2);
  });

  it('2 community on SAME team → no event', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Blue');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(0);
  });

  it('only 1 community member in match → no event', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    // puuid-2 is NOT in users — not a community member

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(0);
  });

  it('empty match_rosters for match_id (older match) → no event', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    // no roster rows for this match

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-no-roster' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(0);
  });

  it('idempotency: ran twice → only first call emits (detected_events guard)', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'win' });

    // First call — should emit
    const firstEvents = await communityClashDetector.detectAsync!(record, [], { db });
    expect(firstEvents).toHaveLength(1);

    // Simulate the event being persisted (as detect.ts would do)
    await db.insert(detectedEvents).values({
      event_type: 'community_clash',
      riot_puuid: 'puuid-1',
      match_id: 'match-001',
      payload_json: JSON.stringify(firstEvents[0]!.payload),
    });

    // Second call — should be empty due to idempotency guard
    const secondEvents = await communityClashDetector.detectAsync!(record, [], { db });
    expect(secondEvents).toHaveLength(0);
  });

  it('winner_team_id set correctly when result=win', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'win' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload['winner_team_id']).toBe('Blue');
  });

  it('winner_team_id set correctly when result=loss', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'loss' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload['winner_team_id']).toBe('Red');
  });

  it('winner_team_id is null when result=draw', async () => {
    await seedUser(db, 'puuid-1', 'Player1', 'TAG1');
    await seedUser(db, 'puuid-2', 'Player2', 'TAG2');
    await seedRoster(db, 'match-001', 'puuid-1', 'Blue');
    await seedRoster(db, 'match-001', 'puuid-2', 'Red');

    const record = makeRecord({ riot_puuid: 'puuid-1', match_id: 'match-001', result: 'draw' });
    const events = await communityClashDetector.detectAsync!(record, [], { db });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload['winner_team_id']).toBeNull();
  });
});
