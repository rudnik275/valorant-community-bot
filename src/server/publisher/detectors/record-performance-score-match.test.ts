import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { recordPerformanceScoreMatchDetector } from './record-performance-score-match.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    riot_puuid: 'puuid-test',
    match_id: 'match-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 20,
    deaths: 12,
    assists: 4,
    result: 'win',
    rounds_played: 22,
    rank_before: null,
    rank_after: null,
    enemy_avg_rank: null,
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
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    survived_last_rounds: null,
    died_first_rounds: null,
    performance_score: null,
    rr_change: null,
    inserted_at: 1750000000000,
    ...overrides,
  };
}

function seedUser(sqlite: Database.Database, puuid: string, riotName: string, riotTag: string) {
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Math.floor(Math.random() * 100000), puuid, riotName, riotTag, Date.now());
}

function storedRecord(sqlite: Database.Database) {
  return sqlite
    .prepare(`SELECT riot_puuid, value, match_id FROM all_time_records WHERE record_type = 'performance_score_match'`)
    .get() as { riot_puuid: string; value: number; match_id: string } | undefined;
}

describe('recordPerformanceScoreMatchDetector', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it('null performance_score (scanned before #384) → no event, no record row', async () => {
    const events = await recordPerformanceScoreMatchDetector.detect(makeRecord(), [], { db });
    expect(events).toHaveLength(0);
    expect(storedRecord(sqlite)).toBeUndefined();
  });

  it('zero score → no event', async () => {
    const events = await recordPerformanceScoreMatchDetector.detect(makeRecord({ performance_score: 0 }), [], { db });
    expect(events).toHaveLength(0);
  });

  it('first record (no prev) → emits the rounded score with prev_value=null', async () => {
    const events = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 284.6 }),
      [],
      { db },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('record_performance_score_match');
    expect(events[0]!.riot_puuid).toBe('puuid-test');
    expect(events[0]!.payload.value).toBe(285);
    expect(events[0]!.payload.prev_value).toBeNull();
    expect(events[0]!.payload.prev_puuid).toBeNull();
    expect(storedRecord(sqlite)).toEqual({ riot_puuid: 'puuid-test', value: 285, match_id: 'match-001' });
  });

  it('beats the existing record → emits with prev_value, prev_puuid and prev nick', async () => {
    seedUser(sqlite, 'puuid-first', 'FirstPlayer', 'FIRST');
    await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 300.2, match_id: 'match-first', riot_puuid: 'puuid-first' }),
      [],
      { db },
    );

    const events = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 355.1, match_id: 'match-new', riot_puuid: 'puuid-new' }),
      [],
      { db },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.value).toBe(355);
    expect(events[0]!.payload.prev_value).toBe(300);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-first');
    expect(events[0]!.payload.prev_name).toBe('FirstPlayer');
    expect(events[0]!.payload.prev_tag).toBe('FIRST');
    expect(storedRecord(sqlite)!.riot_puuid).toBe('puuid-new');
  });

  it('lower score → no event, the holder keeps the record', async () => {
    await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 320, match_id: 'match-first', riot_puuid: 'puuid-first' }),
      [],
      { db },
    );
    const events = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 250, match_id: 'match-lower', riot_puuid: 'puuid-lower' }),
      [],
      { db },
    );
    expect(events).toHaveLength(0);
    expect(storedRecord(sqlite)!.riot_puuid).toBe('puuid-first');
  });

  it('a score that rounds to the record ties it → no event (strict >)', async () => {
    // 300.2 and 299.6 both round to 300: a tie on the rounded value, so the
    // first player to reach it keeps the record.
    await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 300.2, match_id: 'match-first', riot_puuid: 'puuid-first' }),
      [],
      { db },
    );
    const tie = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 299.6, match_id: 'match-tie', riot_puuid: 'puuid-tie' }),
      [],
      { db },
    );
    const alsoTie = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 300.4, match_id: 'match-tie-2', riot_puuid: 'puuid-tie' }),
      [],
      { db },
    );
    expect(tie).toHaveLength(0);
    expect(alsoTie).toHaveLength(0);
    expect(storedRecord(sqlite)!.riot_puuid).toBe('puuid-first');
  });

  it('same player beats own record → prev_puuid is their own', async () => {
    await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 260, match_id: 'match-a', riot_puuid: 'puuid-same' }),
      [],
      { db },
    );
    const events = await recordPerformanceScoreMatchDetector.detect(
      makeRecord({ performance_score: 290, match_id: 'match-b', riot_puuid: 'puuid-same' }),
      [],
      { db },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.prev_puuid).toBe('puuid-same');
    expect(events[0]!.payload.prev_value).toBe(260);
  });

  it('null riot_puuid → no event', async () => {
    const record = makeRecord({ riot_puuid: null as unknown as string, performance_score: 300 });
    const events = await recordPerformanceScoreMatchDetector.detect(record, [], { db });
    expect(events).toHaveLength(0);
  });
});
