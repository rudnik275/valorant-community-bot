import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { scannerEvents } from '../scanner/events.ts';
import { startDetectionListener } from './detect.ts';
import type { MatchRecord } from './types.ts';

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
  sqlite.exec('PRAGMA foreign_keys=OFF;'); // allow orphan rows without users table
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const TARGET_PUUID = 'puuid-detect-test';

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    riot_puuid: TARGET_PUUID,
    match_id: 'match-detect-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 5,
    deaths: 12,
    assists: 2,
    result: 'loss',
    rounds_played: 20,
    rank_before: null,
    rank_after: 'Diamond 1',
    enemy_avg_rank: 'Diamond 1',
    fall_damage_kills: 0,
    kill_events_compact: '[]',
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

describe('startDetectionListener', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    scannerEvents.removeAllListeners();
    vi.clearAllMocks();
  });

  it('inserts detected_events when newRecord is emitted', async () => {
    const cleanup = startDetectionListener({ db, getPrevRecords: async () => [] });

    const record = makeRecord();
    scannerEvents.emit('newRecord', record);

    // Wait for async handler to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = sqlite.prepare('SELECT event_type FROM detected_events WHERE riot_puuid = ?').all(TARGET_PUUID);
    expect(rows.length).toBeGreaterThan(0);

    cleanup();
  });

  it('does NOT insert when newRecord is NOT emitted (initial backfill path)', async () => {
    const cleanup = startDetectionListener({ db, getPrevRecords: async () => [] });

    // Deliberately NOT emitting newRecord — simulates detection:false backfill
    // (no scannerEvents.emit call here)

    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = sqlite.prepare('SELECT * FROM detected_events').all();
    expect(rows).toHaveLength(0);

    cleanup();
  });

  it('handles UNIQUE conflict (duplicate event) without throwing', async () => {
    const cleanup = startDetectionListener({ db, getPrevRecords: async () => [] });

    const record = makeRecord({ fall_damage_kills: 2 });

    // Emit the same record twice → second insert should hit UNIQUE constraint
    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));
    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should only have one row per event type despite two emissions
    const rows = sqlite.prepare(
      "SELECT event_type, COUNT(*) as count FROM detected_events WHERE riot_puuid = ? AND event_type = 'fall_damage_death' GROUP BY event_type",
    ).all(TARGET_PUUID) as { event_type: string; count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);

    cleanup();
  });

  it('cleanup function stops receiving events after call', async () => {
    const cleanup = startDetectionListener({ db, getPrevRecords: async () => [] });

    cleanup(); // unsubscribe immediately

    scannerEvents.emit('newRecord', makeRecord());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = sqlite.prepare('SELECT * FROM detected_events').all();
    expect(rows).toHaveLength(0);
  });

  it('inserts fall_damage_death event', async () => {
    const cleanup = startDetectionListener({ db, getPrevRecords: async () => [] });

    scannerEvents.emit(
      'newRecord',
      makeRecord({ match_id: 'match-fall-001', kills: 5, rounds_played: 20, fall_damage_kills: 2 }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = sqlite.prepare(
      "SELECT * FROM detected_events WHERE event_type = 'fall_damage_death'",
    ).all();
    expect(rows).toHaveLength(1);

    cleanup();
  });

  it('passes prevRecords to detectors via injectable getPrevRecords', async () => {
    const getPrevRecords = vi.fn().mockResolvedValue([]);
    const cleanup = startDetectionListener({ db, getPrevRecords });

    scannerEvents.emit('newRecord', makeRecord());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getPrevRecords).toHaveBeenCalledWith(TARGET_PUUID, 1750000000000);

    cleanup();
  });
});
