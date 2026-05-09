import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { scanForPuuid } from './scan.ts';
import { scannerEvents } from './events.ts';
import {
  HenrikRateLimitError,
  HenrikNotFoundError,
  HenrikUpstreamError,
} from '../lib/henrik.ts';

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

const TARGET_PUUID = 'target-puuid-scan-test';

/** A minimal valid Henrik v3 match response */
function makeFakeMatchResponse(matchId: string, mode = 'Competitive') {
  return {
    status: 200,
    data: [
      {
        metadata: {
          matchid: matchId,
          mode,
          map: 'Ascent',
          game_start: 1700000000,
          rounds_played: 25,
        },
        players: {
          all_players: [
            {
              puuid: TARGET_PUUID,
              team: 'Blue',
              character: 'Jett',
              stats: { kills: 20, deaths: 10, assists: 5 },
              currenttier: 18,
              currenttier_patched: 'Diamond 1',
            },
            {
              puuid: 'enemy-1',
              team: 'Red',
              character: 'Reyna',
              stats: { kills: 15, deaths: 14, assists: 3 },
              currenttier: 18,
              currenttier_patched: 'Diamond 1',
            },
            {
              puuid: 'enemy-2',
              team: 'Red',
              character: 'Phoenix',
              stats: { kills: 12, deaths: 15, assists: 5 },
              currenttier: 19,
              currenttier_patched: 'Diamond 2',
            },
            {
              puuid: 'enemy-3',
              team: 'Red',
              character: 'Breach',
              stats: { kills: 10, deaths: 16, assists: 8 },
              currenttier: 17,
              currenttier_patched: 'Platinum 3',
            },
            {
              puuid: 'enemy-4',
              team: 'Red',
              character: 'Viper',
              stats: { kills: 9, deaths: 17, assists: 6 },
              currenttier: 18,
              currenttier_patched: 'Diamond 1',
            },
            {
              puuid: 'enemy-5',
              team: 'Red',
              character: 'Cypher',
              stats: { kills: 8, deaths: 18, assists: 10 },
              currenttier: 19,
              currenttier_patched: 'Diamond 2',
            },
          ],
        },
        teams: {
          red: { has_won: false, rounds_won: 11, rounds_lost: 14 },
          blue: { has_won: true, rounds_won: 14, rounds_lost: 11 },
        },
        kills: [],
        rounds: [],
      },
    ],
  };
}

function makeAccountResponse() {
  return {
    status: 200,
    data: {
      puuid: TARGET_PUUID,
      region: 'eu',
      name: 'TestPlayer',
      tag: 'EU1',
    },
  };
}

describe('scanForPuuid', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
    scannerEvents.removeAllListeners();
  });

  function seedUser(region: string | null = 'eu') {
    const insertSql = region
      ? `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, riot_region, joined_at)
         VALUES (111, '${TARGET_PUUID}', 'TestPlayer', 'EU1', '${region}', ${Date.now()})`
      : `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, joined_at)
         VALUES (111, '${TARGET_PUUID}', 'TestPlayer', 'EU1', ${Date.now()})`;
    sqlite.exec(insertSql);
  }

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('inserts new match records and returns them', async () => {
    seedUser();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(makeFakeMatchResponse('new-match-111')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(1);
    expect(result.newRecords[0]!.match_id).toBe('new-match-111');
    expect(result.skippedDuplicates).toBe(0);

    // Verify row in DB
    const rows = sqlite.prepare('SELECT match_id FROM match_records WHERE riot_puuid = ?').all(TARGET_PUUID);
    expect(rows).toHaveLength(1);
  });

  it('skips existing match_id and increments skippedDuplicates', async () => {
    seedUser();
    // Pre-insert the match record
    sqlite.exec(`INSERT INTO match_records
      (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result, rounds_played, kill_events_compact)
      VALUES ('${TARGET_PUUID}', 'existing-match-222', 1700000000000, 'Ascent', 'Jett', 20, 10, 5, 'win', 25, '[]')`);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(makeFakeMatchResponse('existing-match-222')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('returns gracefully on HenrikRateLimitError (429)', async () => {
    seedUser();
    fetchMock.mockResolvedValue(
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('returns gracefully on HenrikNotFoundError (404)', async () => {
    seedUser();
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('returns gracefully on HenrikUpstreamError (5xx)', async () => {
    seedUser();
    // getMatches retries 2x on 5xx → 3 total calls
    fetchMock.mockResolvedValue(new Response('Internal Error', { status: 500 }));

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('returns empty result when user not in DB', async () => {
    // No seed — user does not exist
    const result = await scanForPuuid(db, 'nonexistent-puuid', { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not insert non-competitive matches', async () => {
    seedUser();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(makeFakeMatchResponse('unrated-match-333', 'Unrated')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    const rows = sqlite.prepare('SELECT * FROM match_records WHERE riot_puuid = ?').all(TARGET_PUUID);
    expect(rows).toHaveLength(0);
  });

  // ── detection mode ──────────────────────────────────────────────────────────

  it('emits newRecord events when detection=true', async () => {
    seedUser();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(makeFakeMatchResponse('detect-match-444')), { status: 200 }),
    );

    const emittedRecords: unknown[] = [];
    scannerEvents.on('newRecord', (r) => emittedRecords.push(r));

    await scanForPuuid(db, TARGET_PUUID, { detection: true });

    expect(emittedRecords).toHaveLength(1);
    expect((emittedRecords[0] as { match_id: string }).match_id).toBe('detect-match-444');
  });

  it('does NOT emit newRecord events when detection=false', async () => {
    seedUser();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(makeFakeMatchResponse('silent-match-555')), { status: 200 }),
    );

    const emittedRecords: unknown[] = [];
    scannerEvents.on('newRecord', (r) => emittedRecords.push(r));

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(emittedRecords).toHaveLength(0);
  });

  // ── Lazy region backfill ────────────────────────────────────────────────────

  it('backfills riot_region when null by calling getAccountByPuuid', async () => {
    seedUser(null); // no region

    // First call → getAccountByPuuid
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeAccountResponse()), { status: 200 }),
    );
    // Second call → getMatches
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeFakeMatchResponse('backfill-match-666')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(1);

    // Verify region was persisted
    const row = sqlite.prepare('SELECT riot_region FROM users WHERE riot_puuid = ?').get(TARGET_PUUID) as {
      riot_region: string;
    };
    expect(row.riot_region).toBe('eu');
  });

  it('skips scan gracefully if region backfill fails with rate limit', async () => {
    seedUser(null); // no region

    // getAccountByPuuid → 429
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '60' },
      }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    // getMatches should NOT have been called
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Unexpected errors ───────────────────────────────────────────────────────

  it('re-throws unexpected non-Henrik errors', async () => {
    seedUser();
    fetchMock.mockRejectedValue(new Error('Network catastrophe'));

    await expect(
      scanForPuuid(db, TARGET_PUUID, { detection: false }),
    ).rejects.toThrow('Network catastrophe');
  });
});
