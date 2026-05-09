import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateAccount,
  HenrikNotFoundError,
  HenrikRateLimitError,
  HenrikUpstreamError,
  HenrikError,
} from './henrik.ts';

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
