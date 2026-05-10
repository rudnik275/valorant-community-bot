import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateAccount,
  getMatches,
  getMmr,
  getMmrByPuuid,
  extractCardId,
  HenrikNotFoundError,
  HenrikRateLimitError,
  HenrikUpstreamError,
  HenrikError,
  acquireToken,
  __resetTokenBucketForTest,
} from './henrik.ts';
import matchFixture from './__fixtures__/henrik/match_console_v4.json';
import mmrFixture from './__fixtures__/henrik/mmr_console_v3.json';

vi.mock('./log.ts', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function makeTextResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  return new Response(text, { status, headers: responseHeaders });
}

const VALID_HENRIK_RESPONSE = {
  status: 200,
  data: {
    puuid: 'test-puuid-12345',
    region: 'EU',
    account_level: 42,
    name: 'TestPlayer',
    tag: 'EU1',
    card: {},
    last_update: '2024-01-01T00:00:00Z',
  },
};

describe('validateAccount', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Give plenty of tokens so multi-call tests (e.g. 5xx retries) don't hit real sleep.
    __resetTokenBucketForTest({ tokens: 30 });
    delete process.env['HENRIK_API_KEY'];
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed account data on 200 response', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, VALID_HENRIK_RESPONSE));

    const result = await validateAccount('TestPlayer', 'EU1');

    expect(result).toEqual({
      puuid: 'test-puuid-12345',
      name: 'TestPlayer',
      tag: 'EU1',
      region: 'EU',
      cardId: null,
    });
  });

  it('includes Authorization header when HENRIK_API_KEY is set', async () => {
    process.env['HENRIK_API_KEY'] = 'my-secret-key';
    fetchMock.mockResolvedValue(makeResponse(200, VALID_HENRIK_RESPONSE));

    await validateAccount('TestPlayer', 'EU1');

    const callArgs = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(callArgs[1].headers['Authorization']).toBe('my-secret-key');

    delete process.env['HENRIK_API_KEY'];
  });

  it('encodes name and tag in URL', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, VALID_HENRIK_RESPONSE));

    await validateAccount('Test Player', 'EU 1');

    const callArgs = fetchMock.mock.calls[0] as [string, unknown];
    expect(callArgs[0]).toContain(encodeURIComponent('Test Player'));
    expect(callArgs[0]).toContain(encodeURIComponent('EU 1'));
  });

  it('throws HenrikNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { status: 404, errors: [{ message: 'Not found' }] }));

    await expect(validateAccount('NoSuch', 'TAG')).rejects.toThrow(HenrikNotFoundError);
  });

  it('throws HenrikRateLimitError on 429 with retryAfter from header', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(429, { status: 429 }, { 'Retry-After': '30' }),
    );

    const err = await validateAccount('TestPlayer', 'EU1').catch((e) => e);
    expect(err).toBeInstanceOf(HenrikRateLimitError);
    expect((err as HenrikRateLimitError).retryAfter).toBe(30);
  });

  it('throws HenrikRateLimitError on 429 with default retryAfter when header missing', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { status: 429 }));

    const err = await validateAccount('TestPlayer', 'EU1').catch((e) => e);
    expect(err).toBeInstanceOf(HenrikRateLimitError);
    expect((err as HenrikRateLimitError).retryAfter).toBe(60);
  });

  it('does NOT retry on 429', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { status: 429 }, { 'Retry-After': '30' }));

    await expect(validateAccount('TestPlayer', 'EU1')).rejects.toThrow(HenrikRateLimitError);
    // Should only be called once — no retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and eventually throws HenrikUpstreamError', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'));

    await expect(validateAccount('TestPlayer', 'EU1')).rejects.toThrow(HenrikUpstreamError);
    // Initial attempt + 2 retries = 3 total calls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt if first 500 then 200', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeResponse(200, VALID_HENRIK_RESPONSE));

    const result = await validateAccount('TestPlayer', 'EU1');
    expect(result.puuid).toBe('test-puuid-12345');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws HenrikError on malformed JSON', async () => {
    const malformedResponse = new Response('not json{{', { status: 200 });
    fetchMock.mockResolvedValue(malformedResponse);

    await expect(validateAccount('TestPlayer', 'EU1')).rejects.toThrow(HenrikError);
  });

  it('throws HenrikError on valid JSON but wrong schema', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { status: 200, data: { wrong: 'shape' } }));

    await expect(validateAccount('TestPlayer', 'EU1')).rejects.toThrow(HenrikError);
  });

  it('throws HenrikError on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('Network unreachable'));

    await expect(validateAccount('TestPlayer', 'EU1')).rejects.toThrow(HenrikError);
  });
});

// ─── getMatches (v4 console) ─────────────────────────────────────────────────

describe('getMatches', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Give plenty of tokens so multi-call tests (e.g. 5xx retries) don't hit real sleep.
    __resetTokenBucketForTest({ tokens: 30 });
    delete process.env['HENRIK_API_KEY'];
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed v4 matches from fixture on 200', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, matchFixture));

    const result = await getMatches('26f40503-6b6d-576c-a32d-9fcb8f081042', 'eu');

    expect(result).toHaveLength(1);
    const match = result[0]!;
    const player = match.players[0]!;
    expect(match.metadata.match_id).toBe('test-match-id-1');
    expect(match.metadata.queue?.id).toBe('console_competitive');
    expect(match.metadata.map?.name).toBe('Haven');
    expect(player.puuid).toBe('26f40503-6b6d-576c-a32d-9fcb8f081042');
    expect(player.stats?.kills).toBe(16);
  });

  it('uses default platform=console and size=5 in URL', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, matchFixture));

    await getMatches('test-puuid', 'eu');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v4/by-puuid/matches/eu/console/test-puuid');
    expect(url).toContain('size=5');
    // Must NOT contain mode=
    expect(url).not.toContain('mode=');
  });

  it('respects platform=pc override', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, matchFixture));

    await getMatches('test-puuid', 'eu', { platform: 'pc', size: 10 });

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v4/by-puuid/matches/eu/pc/test-puuid');
    expect(url).toContain('size=10');
  });

  it('URL-encodes all path segments', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, matchFixture));

    const puuid = 'puuid with spaces';
    await getMatches(puuid, 'na', { platform: 'console' });

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain(encodeURIComponent(puuid));
  });

  it('throws HenrikNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { status: 404 }));

    await expect(getMatches('test-puuid', 'eu')).rejects.toThrow(HenrikNotFoundError);
  });

  it('throws HenrikRateLimitError on 429', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { status: 429 }, { 'Retry-After': '45' }));

    const err = await getMatches('test-puuid', 'eu').catch((e) => e);
    expect(err).toBeInstanceOf(HenrikRateLimitError);
    expect((err as HenrikRateLimitError).retryAfter).toBe(45);
  });

  it('throws HenrikUpstreamError after retries on 500', async () => {
    fetchMock
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(makeTextResponse(500, 'Internal Server Error'));

    await expect(getMatches('test-puuid', 'eu')).rejects.toThrow(HenrikUpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ─── getMmr ──────────────────────────────────────────────────────────────────

describe('getMmr', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    __resetTokenBucketForTest({ tokens: 30 });
    delete process.env['HENRIK_API_KEY'];
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed MMR from fixture on 200', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    const result = await getMmr('rudі', '1111', 'eu');

    expect(result.current.tier.id).toBe(21);
    expect(result.current.tier.name).toBe('Ascendant 1');
    expect(result.current.rr).toBe(0);
    expect(result.current.last_change).toBe(-18);
    expect(result.peak).not.toBeNull();
    expect(result.peak?.tier.id).toBe(22);
    expect(result.peak?.tier.name).toBe('Ascendant 2');
    expect(result.peak?.season).toBe('e11a1');
  });

  it('uses default platform=console in URL', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    await getMmr('rudі', '1111', 'eu');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v3/mmr/eu/console/');
  });

  it('respects platform=pc override', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    await getMmr('TestPlayer', 'EU1', 'eu', 'pc');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v3/mmr/eu/pc/');
  });

  it('URL-encodes name and tag (Cyrillic)', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    await getMmr('rudі', '1111', 'eu');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    // 'і' is U+0456 (Ukrainian і), should be encoded
    expect(url).toContain(encodeURIComponent('rudі'));
  });

  it('throws HenrikNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { status: 404 }));

    await expect(getMmr('NoSuch', 'TAG', 'eu')).rejects.toThrow(HenrikNotFoundError);
  });

  it('throws HenrikRateLimitError on 429', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { status: 429 }, { 'Retry-After': '60' }));

    const err = await getMmr('TestPlayer', 'EU1', 'eu').catch((e) => e);
    expect(err).toBeInstanceOf(HenrikRateLimitError);
    expect((err as HenrikRateLimitError).retryAfter).toBe(60);
  });
});

// ─── getMmrByPuuid ────────────────────────────────────────────────────────────

describe('getMmrByPuuid', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    __resetTokenBucketForTest({ tokens: 30 });
    delete process.env['HENRIK_API_KEY'];
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed MMR from fixture on 200', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    const result = await getMmrByPuuid('26f40503-6b6d-576c-a32d-9fcb8f081042', 'eu');

    expect(result.current.tier.id).toBe(21);
    expect(result.current.rr).toBe(0);
    expect(result.peak?.tier.name).toBe('Ascendant 2');
    expect(result.peak?.season).toBe('e11a1');
  });

  it('uses default platform=console in URL', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    await getMmrByPuuid('test-puuid', 'eu');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v3/by-puuid/mmr/eu/console/test-puuid');
  });

  it('respects platform=pc override', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, mmrFixture));

    await getMmrByPuuid('test-puuid', 'na', 'pc');

    const url = (fetchMock.mock.calls[0] as [string, unknown])[0] as string;
    expect(url).toContain('/valorant/v3/by-puuid/mmr/na/pc/test-puuid');
  });

  it('throws HenrikNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(makeResponse(404, { status: 404 }));

    await expect(getMmrByPuuid('no-such-puuid', 'eu')).rejects.toThrow(HenrikNotFoundError);
  });

  it('throws HenrikRateLimitError on 429', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { status: 429 }, { 'Retry-After': '30' }));

    const err = await getMmrByPuuid('test-puuid', 'eu').catch((e) => e);
    expect(err).toBeInstanceOf(HenrikRateLimitError);
    expect((err as HenrikRateLimitError).retryAfter).toBe(30);
  });

  it('handles null peak gracefully', async () => {
    const fixtureWithNullPeak = {
      status: 200,
      data: {
        account: { name: 'test', tag: '0000', puuid: 'abc' },
        current: { tier: { id: 3, name: 'Iron 3' }, rr: 50, last_change: 10, elo: 150 },
        peak: null,
        seasonal: [],
      },
    };
    fetchMock.mockResolvedValue(makeResponse(200, fixtureWithNullPeak));

    const result = await getMmrByPuuid('abc', 'eu');
    expect(result.peak).toBeNull();
    expect(result.current.tier.id).toBe(3);
  });
});

// ─── Token-bucket rate limiter ───────────────────────────────────────────────

describe('token-bucket rate limiter (acquireToken)', () => {
  // All tests use injectable now/sleep to avoid wall-clock slowness.

  it('burst of BURST tokens fires immediately without waiting', async () => {
    // Fresh bucket: tokens = BURST = 1.
    const t0 = 1_000_000;
    __resetTokenBucketForTest({ tokens: 1, now: t0 });
    const nowFn = vi.fn(() => t0); // time frozen — no refill
    const sleepFn = vi.fn((_ms: number) => Promise.resolve());

    const burst = 1;
    await Promise.all(Array.from({ length: burst }, () => acquireToken(nowFn, sleepFn)));

    // 1 token consumed without sleeping.
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('second call waits when bucket is drained', async () => {
    // Drain 1 token then call once more — sleepFn must be called.
    const t0 = 2_000_000;
    const TOKEN_REFILL_MS = 60_000 / 20; // 3000 ms
    __resetTokenBucketForTest({ tokens: 1, now: t0 });

    // First call: bucket drains, time stays frozen.
    let currentTime = t0;
    const nowFn = vi.fn(() => currentTime);

    let resolveSlept: () => void;
    const sleepFn = vi.fn((_ms: number): Promise<void> => {
      // Advance time past one refill so the next acquireToken loop grants a token.
      currentTime = t0 + TOKEN_REFILL_MS + 1;
      resolveSlept!();
      return Promise.resolve();
    });

    // Drain the burst (1 token)
    await acquireToken(nowFn, sleepFn);
    expect(sleepFn).not.toHaveBeenCalled();

    // 2nd call should trigger sleep
    resolveSlept = () => {}; // placeholder
    await acquireToken(nowFn, sleepFn);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    const waitArg = sleepFn.mock.calls[0]![0] as number;
    expect(waitArg).toBeGreaterThan(0);
  });

  it('refill restores capacity after waiting TOKEN_REFILL_MS * BURST', async () => {
    // Drain bucket, advance time by BURST * TOKEN_REFILL_MS, verify next BURST calls don't sleep.
    const BURST = 1;
    const TOKEN_REFILL_MS = 60_000 / 20; // 3000 ms
    const t0 = 3_000_000;
    __resetTokenBucketForTest({ tokens: 0, now: t0 }); // already drained

    // Time is advanced past a full refill cycle.
    const currentTime = t0 + BURST * TOKEN_REFILL_MS + 1;
    const nowFn = vi.fn(() => currentTime);
    const sleepFn = vi.fn((_ms: number) => Promise.resolve());

    // Should get BURST tokens without sleeping.
    await Promise.all(Array.from({ length: BURST }, () => acquireToken(nowFn, sleepFn)));
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

// ─── extractCardId ────────────────────────────────────────────────────────────

describe('extractCardId', () => {
  it('returns the string as-is when card is a string', () => {
    expect(extractCardId('some-card-uuid')).toBe('some-card-uuid');
  });

  it('returns the id field when card is an object with id', () => {
    expect(extractCardId({ id: 'card-id-from-object', small: 'https://…', large: 'https://…' })).toBe('card-id-from-object');
  });

  it('returns null when card is null', () => {
    expect(extractCardId(null)).toBeNull();
  });

  it('returns null when card is undefined', () => {
    expect(extractCardId(undefined)).toBeNull();
  });

  it('returns null when card is an object without id', () => {
    expect(extractCardId({ small: 'https://…' })).toBeNull();
  });
});
