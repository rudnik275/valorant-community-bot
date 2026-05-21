import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { winstreakDetector } from './winstreak.ts';
import type { MatchRecord } from '../types.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function makeRecord(matchId: string, result: 'win' | 'loss' | 'draw', startedAt: number): MatchRecord {
  return {
    riot_puuid: 'puuid-1',
    match_id: matchId,
    started_at: startedAt,
    map: 'Ascent',
    agent: 'Jett',
    kills: 10,
    deaths: 5,
    assists: 2,
    result,
    rounds_played: 25,
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
    team_rounds_won: null,
    team_rounds_lost: null,
    game_length_ms: null,
    is_match_mvp: null,
    survived_last_rounds: null,    died_first_rounds: null,    inserted_at: startedAt,
  };
}

/** Creates N previous win records in desc order */
function makeWinStreak(n: number, baseTime: number): MatchRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord(`prev-${i}`, 'win', baseTime - (i + 1) * 3600_000),
  );
}

describe('winstreakDetector', () => {
  const NOW = 1700000000000; // Monday 2023-11-15T02:13:20Z

  let db: ReturnType<typeof drizzle>;
  let sqlite: Database.Database;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    // Seed a user row so FK constraints don't bite (FK off anyway but be tidy)
    sqlite.prepare(
      `INSERT OR IGNORE INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
       VALUES (1, 'puuid-1', 'TestPlayer', 'TAG', ?)`,
    ).run(NOW);
  });

  it('detects a 10-win streak', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(9, NOW); // 9 previous wins + current = 10
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('winstreak_10plus');
    expect(events[0]!.payload.streak).toBe(10);
  });

  it('detects a streak of 11', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(10, NOW); // 10 previous wins + current = 11
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('winstreak_10plus');
    expect(events[0]!.payload.streak).toBe(11);
  });

  it('detects a streak of 12', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(11, NOW); // 11 previous wins + current = 12
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.streak).toBe(12);
  });

  it('does NOT emit for streak of 9', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(8, NOW); // 8 previous wins + current = 9
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit for streak of 8', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(7, NOW); // 7 previous wins + current = 8
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(0);
  });

  it('does NOT emit when current match is a loss', async () => {
    const record = makeRecord('current', 'loss', NOW);
    const prev = makeWinStreak(10, NOW);
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(0);
  });

  it('breaks streak on draw', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = [
      makeRecord('p1', 'win', NOW - 1 * 3600_000),
      makeRecord('p2', 'win', NOW - 2 * 3600_000),
      makeRecord('p3', 'draw', NOW - 3 * 3600_000), // draw breaks streak
      ...makeWinStreak(8, NOW - 4 * 3600_000),
    ];
    // streak is only 3 (current + p1 + p2)
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(0);
  });

  it('includes started_match_id in payload', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(9, NOW);
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events[0]!.payload.started_match_id).toBeTruthy();
  });

  it('weekly dedup: same puuid emits once, then suppressed for same ISO week', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(9, NOW);

    // First call — should emit
    const events1 = await winstreakDetector.detect(record, prev, { db });
    expect(events1).toHaveLength(1);

    // Simulate the event being persisted (as detect.ts would do it)
    sqlite.prepare(
      `INSERT OR IGNORE INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at)
       VALUES ('winstreak_10plus', 'puuid-1', 'current', '{}', ?)`,
    ).run(NOW);

    // Second call — same week, same puuid → should be suppressed
    const record2 = makeRecord('current2', 'win', NOW + 3600_000);
    const prev2 = makeWinStreak(9, NOW + 3600_000);
    const events2 = await winstreakDetector.detect(record2, prev2, { db });
    expect(events2).toHaveLength(0);
  });

  it('weekly dedup: different ISO week → emits again', async () => {
    const record = makeRecord('current', 'win', NOW);
    const prev = makeWinStreak(9, NOW);

    // Simulate last week's event
    const lastWeekMs = NOW - 7 * 86_400_000;
    sqlite.prepare(
      `INSERT OR IGNORE INTO detected_events (event_type, riot_puuid, match_id, payload_json, detected_at)
       VALUES ('winstreak_10plus', 'puuid-1', 'last-week', '{}', ?)`,
    ).run(lastWeekMs);

    // This week — should still emit
    const events = await winstreakDetector.detect(record, prev, { db });
    expect(events).toHaveLength(1);
  });

  // (Removed: the legacy "sync detect() returns empty" test asserted the
  //  no-op sync stub that issue #254 explicitly removes — the detector now
  //  has a single async detect. Behaviour is covered by the async tests
  //  above.)
});
