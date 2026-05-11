import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { scanForPuuid, CONSOLE_COMPETITIVE_QUEUE } from './scan.ts';
import { scannerEvents } from './events.ts';
import * as henrik from '../lib/henrik.ts';
import { matchRosters } from '../db/schema/match_rosters.ts';

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

/** A minimal valid Henrik v4 match response (console_competitive). */
function makeFakeMatchResponse(matchId: string, queueId = CONSOLE_COMPETITIVE_QUEUE) {
  return {
    status: 200,
    data: [
      {
        metadata: {
          match_id: matchId,
          platform: 'console',
          region: 'eu',
          queue: { id: queueId, name: 'Competitive', mode_type: 'Standard' },
          map: { id: 'map-id', name: 'Ascent' },
          started_at: '2026-05-09T14:00:00.000Z',
          game_length_in_ms: 2000000,
          is_completed: true,
        },
        players: [
          {
            puuid: TARGET_PUUID,
            name: 'TestPlayer',
            tag: 'EU1',
            team_id: 'Blue',
            platform: 'playstation',
            agent: { id: 'jett-id', name: 'Jett' },
            tier: { id: 18, name: 'Diamond 1' },
            stats: { kills: 20, deaths: 10, assists: 5 },
          },
          {
            puuid: 'enemy-1',
            name: 'Enemy1',
            tag: 'NA1',
            team_id: 'Red',
            platform: 'xbox',
            agent: { id: 'reyna-id', name: 'Reyna' },
            tier: { id: 18, name: 'Diamond 1' },
            stats: { kills: 15, deaths: 14, assists: 3 },
          },
          {
            puuid: 'enemy-2',
            name: 'Enemy2',
            tag: 'NA2',
            team_id: 'Red',
            platform: 'playstation',
            agent: { id: 'phoenix-id', name: 'Phoenix' },
            tier: { id: 19, name: 'Diamond 2' },
            stats: { kills: 12, deaths: 15, assists: 5 },
          },
        ],
        teams: [
          { team_id: 'Blue', won: true, rounds: { won: 14, lost: 11 } },
          { team_id: 'Red', won: false, rounds: { won: 11, lost: 14 } },
        ],
        rounds: [],
        kills: [],
      },
    ],
  };
}

/** A v4 response where queue.id is not console_competitive (should be filtered out). */
function makeFakeDeathmatchResponse(matchId: string) {
  return makeFakeMatchResponse(matchId, 'console_deathmatch');
}

/** A v4 response with a full 10-player roster (5 Blue, 5 Red) for roster tests. */
function makeFakeMatchResponseWithFullRoster(matchId: string) {
  const blueTeam = Array.from({ length: 5 }, (_, i) => ({
    puuid: i === 0 ? TARGET_PUUID : `blue-player-${i}`,
    name: i === 0 ? 'TestPlayer' : `BluePlayer${i}`,
    tag: `B${i}`,
    team_id: 'Blue',
    platform: 'playstation',
    agent: { id: 'jett-id', name: 'Jett' },
    tier: { id: 18, name: 'Diamond 1' },
    stats: { kills: 10, deaths: 10, assists: 2 },
  }));
  const redTeam = Array.from({ length: 5 }, (_, i) => ({
    puuid: `red-player-${i}`,
    name: `RedPlayer${i}`,
    tag: `R${i}`,
    team_id: 'Red',
    platform: 'xbox',
    agent: { id: 'reyna-id', name: 'Reyna' },
    tier: { id: 18, name: 'Diamond 1' },
    stats: { kills: 8, deaths: 12, assists: 3 },
  }));
  return {
    status: 200,
    data: [
      {
        metadata: {
          match_id: matchId,
          platform: 'console',
          region: 'eu',
          queue: { id: CONSOLE_COMPETITIVE_QUEUE, name: 'Competitive', mode_type: 'Standard' },
          map: { id: 'map-id', name: 'Ascent' },
          started_at: '2026-05-09T14:00:00.000Z',
          game_length_in_ms: 2000000,
          is_completed: true,
        },
        players: [...blueTeam, ...redTeam],
        teams: [
          { team_id: 'Blue', won: true, rounds: { won: 14, lost: 11 } },
          { team_id: 'Red', won: false, rounds: { won: 11, lost: 14 } },
        ],
        rounds: [],
        kills: [],
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

describe('CONSOLE_COMPETITIVE_QUEUE constant', () => {
  it('equals console_competitive', () => {
    expect(CONSOLE_COMPETITIVE_QUEUE).toBe('console_competitive');
  });
});

describe('scanForPuuid', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Give plenty of tokens so multi-call tests (5xx retries etc.) don't hit real sleep.
    henrik.__resetTokenBucketForTest({ tokens: 30 });
    henrik.__resetBlockUntilForTest();
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
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeMatchResponse('new-match-111')), { status: 200 }),
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

    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeMatchResponse('existing-match-222')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('returns gracefully on HenrikRateLimitError (429)', async () => {
    seedUser();
    // Use Retry-After: 0 so _blockedUntilMs = now+0 — block expires immediately
    // and subsequent acquireToken calls within the same scanForPuuid invocation
    // don't hang for a real 30s window.
    fetchMock.mockImplementation(async () => new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '0' },
      }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('returns gracefully on HenrikNotFoundError (404)', async () => {
    seedUser();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });

  it('returns gracefully on HenrikUpstreamError (5xx)', async () => {
    seedUser();
    // getMmrByPuuid + getAccountByPuuid + getMatches each retry 2x on 5xx → up to 9 total calls
    // with random jitter (500–2000ms/retry). Bumped timeout to 30s so CI doesn't flake.
    fetchMock.mockImplementation(async () => new Response('Internal Error', { status: 500 }));

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  }, 30000);

  it('returns empty result when user not in DB', async () => {
    // No seed — user does not exist
    const result = await scanForPuuid(db, 'nonexistent-puuid', { detection: false });

    expect(result.newRecords).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Console queue filter ────────────────────────────────────────────────────

  it('filters out matches where queue.id !== console_competitive', async () => {
    seedUser();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeDeathmatchResponse('deathmatch-333')), { status: 200 }),
    );

    const result = await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(result.newRecords).toHaveLength(0);
    const rows = sqlite.prepare('SELECT * FROM match_records WHERE riot_puuid = ?').all(TARGET_PUUID);
    expect(rows).toHaveLength(0);
  });

  it('calls getMatches with puuid, region, and platform=console', async () => {
    seedUser();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeMatchResponse('call-check-match')), { status: 200 }),
    );

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    // 3 calls expected: MMR fetch + account card refresh + matches fetch
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const matchesUrl = (fetchMock.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('/v4/by-puuid/matches/'),
    )?.[0] as string | undefined);
    expect(matchesUrl).toBeDefined();
    expect(matchesUrl!).toContain('/console/');
    expect(matchesUrl!).toContain(TARGET_PUUID);
  });

  // ── detection mode ──────────────────────────────────────────────────────────

  it('emits newRecord events when detection=true', async () => {
    seedUser();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeMatchResponse('detect-match-444')), { status: 200 }),
    );

    const emittedRecords: unknown[] = [];
    scannerEvents.on('newRecord', (r) => emittedRecords.push(r));

    await scanForPuuid(db, TARGET_PUUID, { detection: true });

    expect(emittedRecords).toHaveLength(1);
    expect((emittedRecords[0] as { match_id: string }).match_id).toBe('detect-match-444');
  });

  it('does NOT emit newRecord events when detection=false', async () => {
    seedUser();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(makeFakeMatchResponse('silent-match-555')), { status: 200 }),
    );

    const emittedRecords: unknown[] = [];
    scannerEvents.on('newRecord', (r) => emittedRecords.push(r));

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    expect(emittedRecords).toHaveLength(0);
  });

  // ── Lazy region backfill ────────────────────────────────────────────────────

  it('backfills riot_region when null by calling getAccountByPuuid', async () => {
    seedUser(null); // no region

    // First call → getAccountByPuuid (region backfill)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(makeAccountResponse()), { status: 200 }),
    );
    // Second call → getMmrByPuuid (will fail to parse as MMR — that's OK, scan continues)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(makeFakeMatchResponse('mmr-noise')), { status: 200 }),
    );
    // Third call → getAccountByPuuid (card refresh — will fail to parse account response, that's OK)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(makeAccountResponse()), { status: 200 }),
    );
    // Fourth call → getMatches
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(makeFakeMatchResponse('backfill-match-666')), { status: 200 }),
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
    fetchMock.mockImplementationOnce(async () => new Response('{}', {
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

  // ── Preserve known-good on partial Henrik response ──────────────────────────

  it('preserves existing tier fields when MMR response has no current.tier.id', async () => {
    seedUser();
    // Seed existing rank data that must be preserved
    sqlite.exec(`UPDATE users SET current_tier_id = 18, current_tier_name = 'Diamond 1',
      peak_tier_id = 21, peak_tier_name = 'Immortal 1', peak_season_short = 'e8a1'
      WHERE riot_puuid = '${TARGET_PUUID}'`);

    // getMmrByPuuid returns sparse data: current exists but tier.id is undefined at runtime
    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      current: { tier: { id: undefined as any, name: undefined as any }, rr: 0, last_change: 0 },
      peak: null,
    });
    // getAccountByPuuid — return minimal valid account so card step doesn't throw
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID,
      region: 'eu',
      name: 'TestPlayer',
      tag: 'EU1',
      cardId: null,
    });
    // getMatches — return empty list so scan continues cleanly
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const row = sqlite.prepare(
      'SELECT current_tier_id, current_tier_name, peak_tier_id, peak_tier_name, peak_season_short FROM users WHERE riot_puuid = ?',
    ).get(TARGET_PUUID) as {
      current_tier_id: number;
      current_tier_name: string;
      peak_tier_id: number;
      peak_tier_name: string;
      peak_season_short: string;
    };
    // Existing values must be intact
    expect(row.current_tier_id).toBe(18);
    expect(row.current_tier_name).toBe('Diamond 1');
    expect(row.peak_tier_id).toBe(21);
    expect(row.peak_tier_name).toBe('Immortal 1');
    expect(row.peak_season_short).toBe('e8a1');

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('updates tier fields when MMR response returns full current data', async () => {
    seedUser();
    // Seed stale rank
    sqlite.exec(`UPDATE users SET current_tier_id = 10, current_tier_name = 'Silver 1' WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 21, name: 'Immortal 1' }, rr: 55, last_change: -10 },
      peak: { tier: { id: 24, name: 'Radiant' }, rr: 100, season: 'e8a1' },
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID,
      region: 'eu',
      name: 'TestPlayer',
      tag: 'EU1',
      cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const row = sqlite.prepare(
      'SELECT current_tier_id, current_tier_name, peak_tier_id, peak_tier_name, peak_season_short FROM users WHERE riot_puuid = ?',
    ).get(TARGET_PUUID) as {
      current_tier_id: number;
      current_tier_name: string;
      peak_tier_id: number;
      peak_tier_name: string;
      peak_season_short: string;
    };
    expect(row.current_tier_id).toBe(21);
    expect(row.current_tier_name).toBe('Immortal 1');
    expect(row.peak_tier_id).toBe(24);
    expect(row.peak_tier_name).toBe('Radiant');
    expect(row.peak_season_short).toBe('e8a1');

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('preserves existing riot_card_id when account returns cardId: null', async () => {
    seedUser();
    // Seed existing card id
    sqlite.exec(`UPDATE users SET riot_card_id = 'existing-card-abc' WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 18, name: 'Diamond 1' }, rr: 40, last_change: 5 },
      peak: null,
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID,
      region: 'eu',
      name: 'TestPlayer',
      tag: 'EU1',
      cardId: null, // Henrik returned no card — must NOT overwrite
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const row = sqlite.prepare('SELECT riot_card_id FROM users WHERE riot_puuid = ?').get(TARGET_PUUID) as {
      riot_card_id: string;
    };
    expect(row.riot_card_id).toBe('existing-card-abc');

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  // ── peak_rank_up event ──────────────────────────────────────────────────────

  it('emits peak_rank_up detected_event when new peak strictly exceeds old peak (detection=true)', async () => {
    seedUser();
    sqlite.exec(`UPDATE users SET peak_tier_id = 18, peak_tier_name = 'Diamond 1' WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 20, name: 'Diamond 3' }, rr: 50, last_change: 25 },
      peak: { tier: { id: 21, name: 'Immortal 1' }, rr: 0, season: 'e8a1' },
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID, region: 'eu', name: 'TestPlayer', tag: 'EU1', cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: true });

    const row = sqlite.prepare(
      `SELECT event_type, payload_json, status FROM detected_events WHERE riot_puuid = ? AND event_type = 'peak_rank_up'`,
    ).get(TARGET_PUUID) as { event_type: string; payload_json: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('digest-only');
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    expect(payload['from_tier_id']).toBe(18);
    expect(payload['from_tier_name']).toBe('Diamond 1');
    expect(payload['to_tier_id']).toBe(21);
    expect(payload['to_tier_name']).toBe('Immortal 1');

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('does NOT emit peak_rank_up when detection=false (onboarding bulk scan)', async () => {
    seedUser();
    sqlite.exec(`UPDATE users SET peak_tier_id = 18, peak_tier_name = 'Diamond 1' WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 20, name: 'Diamond 3' }, rr: 50, last_change: 25 },
      peak: { tier: { id: 21, name: 'Immortal 1' }, rr: 0, season: 'e8a1' },
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID, region: 'eu', name: 'TestPlayer', tag: 'EU1', cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const rows = sqlite.prepare(
      `SELECT id FROM detected_events WHERE event_type = 'peak_rank_up'`,
    ).all();
    expect(rows).toHaveLength(0);

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('does NOT emit peak_rank_up when old peak is null (first observation)', async () => {
    seedUser();
    // peak_tier_id stays NULL — first time we see this user

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 18, name: 'Diamond 1' }, rr: 50, last_change: 25 },
      peak: { tier: { id: 18, name: 'Diamond 1' }, rr: 100, season: 'e8a1' },
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID, region: 'eu', name: 'TestPlayer', tag: 'EU1', cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: true });

    const rows = sqlite.prepare(
      `SELECT id FROM detected_events WHERE event_type = 'peak_rank_up'`,
    ).all();
    expect(rows).toHaveLength(0);

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('does NOT emit peak_rank_up when new peak equals old peak', async () => {
    seedUser();
    sqlite.exec(`UPDATE users SET peak_tier_id = 21, peak_tier_name = 'Immortal 1' WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      current: { tier: { id: 18, name: 'Diamond 1' }, rr: 50, last_change: 25 },
      peak: { tier: { id: 21, name: 'Immortal 1' }, rr: 0, season: 'e8a1' },
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID, region: 'eu', name: 'TestPlayer', tag: 'EU1', cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: true });

    const rows = sqlite.prepare(
      `SELECT id FROM detected_events WHERE event_type = 'peak_rank_up'`,
    ).all();
    expect(rows).toHaveLength(0);

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  it('preserves all known-good fields when both current and peak arrive null', async () => {
    seedUser();
    sqlite.exec(`UPDATE users SET current_tier_id = 15, current_tier_name = 'Platinum 3',
      peak_tier_id = 18, peak_tier_name = 'Diamond 1', peak_season_short = 'e7a3',
      riot_card_id = 'card-xyz'
      WHERE riot_puuid = '${TARGET_PUUID}'`);

    const mmrSpy = vi.spyOn(henrik, 'getMmrByPuuid').mockResolvedValueOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      current: { tier: { id: undefined as any, name: undefined as any }, rr: 0, last_change: 0 },
      peak: null,
    });
    const accountSpy = vi.spyOn(henrik, 'getAccountByPuuid').mockResolvedValue({
      puuid: TARGET_PUUID,
      region: 'eu',
      name: 'TestPlayer',
      tag: 'EU1',
      cardId: null,
    });
    const matchesSpy = vi.spyOn(henrik, 'getMatches').mockResolvedValueOnce([]);

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const row = sqlite.prepare(
      'SELECT current_tier_id, current_tier_name, peak_tier_id, peak_tier_name, peak_season_short, riot_card_id FROM users WHERE riot_puuid = ?',
    ).get(TARGET_PUUID) as {
      current_tier_id: number;
      current_tier_name: string;
      peak_tier_id: number;
      peak_tier_name: string;
      peak_season_short: string;
      riot_card_id: string;
    };
    expect(row.current_tier_id).toBe(15);
    expect(row.current_tier_name).toBe('Platinum 3');
    expect(row.peak_tier_id).toBe(18);
    expect(row.peak_tier_name).toBe('Diamond 1');
    expect(row.peak_season_short).toBe('e7a3');
    expect(row.riot_card_id).toBe('card-xyz');

    mmrSpy.mockRestore();
    accountSpy.mockRestore();
    matchesSpy.mockRestore();
  });

  // ── match_rosters capture ────────────────────────────────────────────────────

  it('inserts 10 roster rows after scanning a match with a full 10-player roster', async () => {
    seedUser();
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeFakeMatchResponseWithFullRoster('roster-match-001')), { status: 200 }),
    );

    await scanForPuuid(db, TARGET_PUUID, { detection: false });

    const rosters = await db.select().from(matchRosters);
    expect(rosters).toHaveLength(10);
  });

  it('does not duplicate roster rows when the same match is scanned a second time', async () => {
    seedUser();
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(makeFakeMatchResponseWithFullRoster('roster-match-002')), { status: 200 }),
    );

    // First scan
    await scanForPuuid(db, TARGET_PUUID, { detection: false });
    // Pre-insert another community player who was in the same match to simulate
    // what happens when scan.ts processes the same match for two different community players.
    // The second scanForPuuid call here uses the same TARGET_PUUID but the match record
    // already exists — so toInsert is empty and no roster rows are inserted again.
    // To test the actual dedup path, we directly test that onConflictDoNothing works:
    // insert the same roster rows again and verify count stays at 10.
    const firstRosters = await db.select().from(matchRosters);
    expect(firstRosters).toHaveLength(10);

    // Simulate a second scan of the same match (e.g. for a second community player)
    // by directly deriving + inserting rosters again for the same match_id.
    // The DB PK (match_id, riot_puuid) must dedup to exactly 10 rows.
    const { deriveMatchRoster } = await import('./derive.ts');
    const fakeMatch = makeFakeMatchResponseWithFullRoster('roster-match-002').data[0]!;
    const rosterRows = deriveMatchRoster(fakeMatch as Parameters<typeof deriveMatchRoster>[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).insert(matchRosters).values(rosterRows).onConflictDoNothing();

    const secondRosters = await db.select().from(matchRosters);
    expect(secondRosters).toHaveLength(10);
  });
});
