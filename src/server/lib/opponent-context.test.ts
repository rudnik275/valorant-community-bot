/**
 * opponent-context.test.ts — Unit tests for getOpponentPeakRanks and TTL cache.
 *
 * All Henrik API calls are mocked — no live network requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoist mock factories so they're available before imports ─────────────────

vi.mock('./henrik.ts', async () => {
  class HenrikNotFoundError extends Error {
    constructor() {
      super('Riot account not found');
      this.name = 'HenrikNotFoundError';
    }
  }
  class HenrikRateLimitError extends Error {
    retryAfter: number;
    constructor(retryAfter: number) {
      super(`Henrik API rate limited — retry after ${retryAfter}s`);
      this.name = 'HenrikRateLimitError';
      this.retryAfter = retryAfter;
    }
  }
  class HenrikUpstreamError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(`Henrik upstream error ${status}: ${message}`);
      this.name = 'HenrikUpstreamError';
      this.status = status;
    }
  }
  return {
    getMmrByPuuid: vi.fn(),
    HenrikNotFoundError,
    HenrikRateLimitError,
    HenrikUpstreamError,
  };
});

vi.mock('./log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks are set up
import { clearOpponentCache, getOpponentPeakRanks, OPPONENT_CACHE_TTL_MS } from './opponent-context.ts';
import type { Victim } from './opponent-context.ts';
import * as henrik from './henrik.ts';
import logger from './log.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMmrByPuuidMock() {
  return henrik.getMmrByPuuid as ReturnType<typeof vi.fn>;
}

function loggerWarnMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
}

function makeMmrResult(tier_id: number, tier_name: string, season: string) {
  return {
    current: { tier: { id: tier_id, name: tier_name }, rr: 50, last_change: 0 },
    peak: { tier: { id: tier_id, name: tier_name }, rr: 50, season },
  };
}

function makeVictim(puuid: string, name = '', tag = ''): Victim {
  return { puuid, name, tag };
}

const FAST_TTL = 50; // 50ms TTL for testing expiry quickly

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getOpponentPeakRanks', () => {
  beforeEach(() => {
    clearOpponentCache();
    getMmrByPuuidMock().mockReset();
    loggerWarnMock().mockReset();
  });

  afterEach(() => {
    clearOpponentCache();
  });

  it('returns peak ranks for all found victims', async () => {
    getMmrByPuuidMock()
      .mockResolvedValueOnce(makeMmrResult(19, 'Diamond 2', 'e9'))
      .mockResolvedValueOnce(makeMmrResult(21, 'Ascendant 1', 'e9'));

    const victims = [makeVictim('puuid-1'), makeVictim('puuid-2')];
    const result = await getOpponentPeakRanks(victims, 'eu');

    expect(result.size).toBe(2);
    expect(result.get('puuid-1')).toMatchObject({ tier_id: 19, tier_name: 'Diamond 2', season_short: 'e9' });
    expect(result.get('puuid-2')).toMatchObject({ tier_id: 21, tier_name: 'Ascendant 1', season_short: 'e9' });
    expect(getMmrByPuuidMock()).toHaveBeenCalledTimes(2);
  });

  it('uses cache hit — no second API call for same puuid', async () => {
    getMmrByPuuidMock().mockResolvedValue(makeMmrResult(24, 'Immortal 1', 'e8'));

    const victims = [makeVictim('puuid-cache')];

    // First call — populates cache
    await getOpponentPeakRanks(victims, 'eu');
    // Second call — should use cache
    const result = await getOpponentPeakRanks(victims, 'eu');

    expect(getMmrByPuuidMock()).toHaveBeenCalledTimes(1);
    expect(result.get('puuid-cache')).toMatchObject({ tier_name: 'Immortal 1' });
  });

  it('re-fetches after TTL expiry', async () => {
    getMmrByPuuidMock().mockResolvedValue(makeMmrResult(18, 'Diamond 1', 'e7'));

    const victims = [makeVictim('puuid-ttl')];

    // First call
    await getOpponentPeakRanks(victims, 'eu', { ttlMs: FAST_TTL });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, FAST_TTL + 10));

    // Second call after expiry
    await getOpponentPeakRanks(victims, 'eu', { ttlMs: FAST_TTL });

    expect(getMmrByPuuidMock()).toHaveBeenCalledTimes(2);
  });

  it('omits puuid when HenrikNotFoundError is thrown', async () => {
    const { HenrikNotFoundError } = henrik as typeof henrik & { HenrikNotFoundError: new () => Error };
    getMmrByPuuidMock().mockRejectedValue(new HenrikNotFoundError());

    const victims = [makeVictim('puuid-notfound')];
    const result = await getOpponentPeakRanks(victims, 'eu');

    expect(result.size).toBe(0);
    expect(getMmrByPuuidMock()).toHaveBeenCalledTimes(1);
  });

  it('aborts loop on HenrikRateLimitError and returns partial results', async () => {
    const { HenrikRateLimitError } = henrik as typeof henrik & { HenrikRateLimitError: new (r: number) => Error };
    getMmrByPuuidMock()
      .mockResolvedValueOnce(makeMmrResult(19, 'Diamond 2', 'e9'))
      .mockRejectedValueOnce(new HenrikRateLimitError(60));

    const victims = [makeVictim('puuid-ok'), makeVictim('puuid-ratelimit'), makeVictim('puuid-never')];
    const result = await getOpponentPeakRanks(victims, 'eu');

    expect(result.size).toBe(1);
    expect(result.has('puuid-ok')).toBe(true);
    expect(result.has('puuid-ratelimit')).toBe(false);
    expect(result.has('puuid-never')).toBe(false);
    expect(loggerWarnMock()).toHaveBeenCalled();
  });

  it('skips individual victim on HenrikUpstreamError and continues', async () => {
    const { HenrikUpstreamError } = henrik as typeof henrik & { HenrikUpstreamError: new (s: number, m: string) => Error };
    getMmrByPuuidMock()
      .mockRejectedValueOnce(new HenrikUpstreamError(503, 'Service Unavailable'))
      .mockResolvedValueOnce(makeMmrResult(21, 'Ascendant 1', 'e9'));

    const victims = [makeVictim('puuid-upstream'), makeVictim('puuid-ok')];
    const result = await getOpponentPeakRanks(victims, 'eu');

    expect(result.size).toBe(1);
    expect(result.has('puuid-upstream')).toBe(false);
    expect(result.has('puuid-ok')).toBe(true);
    expect(loggerWarnMock()).toHaveBeenCalled();
  });

  it('uses platform option (default console)', async () => {
    getMmrByPuuidMock().mockResolvedValue(makeMmrResult(15, 'Platinum 1', 'e6'));

    await getOpponentPeakRanks([makeVictim('puuid-plat')], 'na');

    expect(getMmrByPuuidMock()).toHaveBeenCalledWith('puuid-plat', 'na', 'console');
  });

  it('uses pc platform when specified', async () => {
    getMmrByPuuidMock().mockResolvedValue(makeMmrResult(15, 'Platinum 1', 'e6'));

    await getOpponentPeakRanks([makeVictim('puuid-pc')], 'na', { platform: 'pc' });

    expect(getMmrByPuuidMock()).toHaveBeenCalledWith('puuid-pc', 'na', 'pc');
  });

  it('omits victim if peak is null (unranked player)', async () => {
    getMmrByPuuidMock().mockResolvedValue({
      current: { tier: { id: 0, name: 'Unrated' }, rr: 0, last_change: 0 },
      peak: null,
    });

    const result = await getOpponentPeakRanks([makeVictim('puuid-unranked')], 'eu');
    expect(result.size).toBe(0);
  });

  it('handles empty victims array', async () => {
    const result = await getOpponentPeakRanks([], 'eu');
    expect(result.size).toBe(0);
    expect(getMmrByPuuidMock()).not.toHaveBeenCalled();
  });

  it('clearOpponentCache removes all entries', async () => {
    getMmrByPuuidMock().mockResolvedValue(makeMmrResult(20, 'Diamond 3', 'e9'));
    await getOpponentPeakRanks([makeVictim('puuid-clear')], 'eu');

    clearOpponentCache();

    // Re-fetch — should hit API again
    await getOpponentPeakRanks([makeVictim('puuid-clear')], 'eu');
    expect(getMmrByPuuidMock()).toHaveBeenCalledTimes(2);
  });

  it('OPPONENT_CACHE_TTL_MS is 24 hours', () => {
    expect(OPPONENT_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
