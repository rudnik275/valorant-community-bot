/**
 * detect-augment.test.ts — Tests for the opponent peak augmentation step in detect.ts.
 *
 * Uses fully injectable deps — no SQLite or live API calls, no module mocking of
 * opponent-context.ts (avoids module registry interference with opponent-context.test.ts).
 *
 * Verifies:
 *   - ace/clutch events get opponents_peak in their payload
 *   - other event types do NOT get opponents_peak
 *   - region is fetched via getRegionForPuuid injectable
 *   - when no region found, augmentation is skipped gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scannerEvents } from '../scanner/events.ts';
import { startDetectionListener } from './detect.ts';
import type { MatchRecord } from './types.ts';
import type { Victim, OpponentPeak } from '../lib/opponent-context.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Minimal mock DB ──────────────────────────────────────────────────────────

type InsertedRow = { event_type: string; riot_puuid: string; match_id: string; payload_json: string };

function makeMockDb() {
  const insertedRows: InsertedRow[] = [];

  const db = {
    insert: (_table: unknown) => ({
      values: (row: InsertedRow) => {
        insertedRows.push(row);
        return { onConflictDoNothing: () => Promise.resolve({ changes: 1 }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
    _insertedRows: insertedRows,
  };

  return db;
}

// ─── Record helpers ───────────────────────────────────────────────────────────

const TARGET_PUUID = 'puuid-augment-test';

function makeAceKills(round = 3): object[] {
  return [
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: TARGET_PUUID, victim_puuid: 'enemy-1' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: TARGET_PUUID, victim_puuid: 'enemy-2' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: TARGET_PUUID, victim_puuid: 'enemy-3' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: TARGET_PUUID, victim_puuid: 'enemy-4' },
    { round, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Vandal', attacker_puuid: TARGET_PUUID, victim_puuid: 'enemy-5' },
  ];
}

function makeRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    riot_puuid: TARGET_PUUID,
    match_id: 'match-augment-001',
    started_at: 1750000000000,
    map: 'Ascent',
    agent: 'Jett',
    kills: 5,
    deaths: 3,
    assists: 1,
    result: 'win',
    rounds_played: 20,
    rank_before: 'Diamond 1',
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('startDetectionListener — opponent peak augmentation', () => {
  afterEach(() => {
    scannerEvents.removeAllListeners();
    vi.clearAllMocks();
  });

  it('augments ace event payload with opponents_peak when region is found', async () => {
    const peakMap = new Map<string, OpponentPeak>([
      ['enemy-1', { tier_id: 19, tier_name: 'Diamond 2', season_short: 'e9' }],
      ['enemy-2', { tier_id: 21, tier_name: 'Ascendant 1', season_short: 'e9' }],
    ]);
    const getOpponentPeakRanksFn = vi.fn().mockResolvedValue(peakMap);

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid: async () => 'eu',
      getOpponentPeakRanksFn,
    });

    const record = makeRecord({
      kill_events_compact: JSON.stringify(makeAceKills(3)),
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    const aceRow = db._insertedRows.find((r) => r.event_type === 'ace');
    expect(aceRow).toBeDefined();
    const payload = JSON.parse(aceRow!.payload_json);
    expect(payload.opponents_peak).toBeDefined();
    expect(payload.opponents_peak['enemy-1']).toMatchObject({ tier_name: 'Diamond 2' });
    expect(payload.opponents_peak['enemy-2']).toMatchObject({ tier_name: 'Ascendant 1' });
  });

  it('does NOT add opponents_peak to non-ace events (e.g., fall_damage_death)', async () => {
    const getOpponentPeakRanksFn = vi.fn().mockResolvedValue(new Map());

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid: async () => 'eu',
      getOpponentPeakRanksFn,
    });

    // fall_damage_kills > 0 → triggers fall_damage_death, no ace
    const record = makeRecord({
      kills: 3,
      fall_damage_kills: 2,
      kill_events_compact: '[]',
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    const fallRow = db._insertedRows.find((r) => r.event_type === 'fall_damage_death');
    expect(fallRow).toBeDefined();
    const payload = JSON.parse(fallRow!.payload_json);
    expect(payload.opponents_peak).toBeUndefined();
    // getOpponentPeakRanks should NOT be called (no ace events)
    expect(getOpponentPeakRanksFn).not.toHaveBeenCalled();
  });

  it('skips augmentation gracefully when no region found', async () => {
    const getOpponentPeakRanksFn = vi.fn();

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid: async () => null,
      getOpponentPeakRanksFn,
    });

    const record = makeRecord({
      kill_events_compact: JSON.stringify(makeAceKills(3)),
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    // Should not call opponent peak lookup
    expect(getOpponentPeakRanksFn).not.toHaveBeenCalled();

    // ace event should still be inserted (just without opponents_peak)
    const aceRow = db._insertedRows.find((r) => r.event_type === 'ace');
    expect(aceRow).toBeDefined();
    const payload = JSON.parse(aceRow!.payload_json);
    expect(payload.opponents_peak).toBeUndefined();
  });

  it('calls getOpponentPeakRanksFn with correct victims and region', async () => {
    const getOpponentPeakRanksFn = vi.fn().mockResolvedValue(new Map());

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid: async () => 'ap',
      getOpponentPeakRanksFn,
    });

    const record = makeRecord({
      kill_events_compact: JSON.stringify(makeAceKills(2)),
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    expect(getOpponentPeakRanksFn).toHaveBeenCalledOnce();
    const [victims, region] = getOpponentPeakRanksFn.mock.calls[0]!;
    expect(region).toBe('ap');
    const puuids = (victims as Victim[]).map((v) => v.puuid);
    expect(puuids).toContain('enemy-1');
    expect(puuids).toContain('enemy-5');
    expect(puuids).toHaveLength(5);
  });

  it('getRegionForPuuid injectable is called with correct puuid', async () => {
    const getOpponentPeakRanksFn = vi.fn().mockResolvedValue(new Map());
    const getRegionForPuuid = vi.fn().mockResolvedValue('eu');

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid,
      getOpponentPeakRanksFn,
    });

    const record = makeRecord({
      kill_events_compact: JSON.stringify(makeAceKills(1)),
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    expect(getRegionForPuuid).toHaveBeenCalledWith(TARGET_PUUID);
  });

  it('de-duplicates victims across multiple ace/clutch events in same match', async () => {
    const getOpponentPeakRanksFn = vi.fn().mockResolvedValue(new Map());

    const db = makeMockDb();
    const cleanup = startDetectionListener({
      db: db as never,
      getPrevRecords: async () => [],
      getRegionForPuuid: async () => 'eu',
      getOpponentPeakRanksFn,
    });

    // Two ace rounds sharing the same victims (unusual but valid)
    const kills = [
      ...makeAceKills(1),
      ...makeAceKills(5), // same victim puuids (enemy-1..5) — should be de-duped
    ];

    const record = makeRecord({
      kill_events_compact: JSON.stringify(kills),
    });

    scannerEvents.emit('newRecord', record);
    await new Promise((resolve) => setTimeout(resolve, 50));

    cleanup();

    expect(getOpponentPeakRanksFn).toHaveBeenCalledOnce();
    const [victims] = getOpponentPeakRanksFn.mock.calls[0]!;
    // Should have exactly 5 unique victims (not 10)
    expect((victims as Victim[]).length).toBe(5);
  });
});
