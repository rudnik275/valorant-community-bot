import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateStoryImage, OpenAIImageError } from './openai-image.ts';

vi.mock('../lib/log.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// readFile of the reference PNGs must not hit disk.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-bytes')),
}));

// sharp must not actually decode our fake bytes — return a deterministic buffer.
vi.mock('sharp', () => {
  const chain = {
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('normalised-1080x1920-png')),
  };
  return { default: vi.fn(() => chain) };
});

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

describe('generateStoryImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  const baseArgs = {
    agentPath: '/assets/agents/jett.png',
    mapPath: '/assets/maps/ascent.png',
    digestText: 'PROMPT + digest',
    apiKey: 'sk-test',
  };

  it('returns a non-empty PNG Buffer on a 200 response', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(200, { data: [{ b64_json: Buffer.from('img').toString('base64') }] }),
    );

    const out = await generateStoryImage(baseArgs);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws OpenAIImageError on a 429 response', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { error: { message: 'rate limited' } }));

    const err = await generateStoryImage(baseArgs).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAIImageError);
    expect((err as OpenAIImageError).status).toBe(429);
  });

  it('throws OpenAIImageError on a 500 response', async () => {
    fetchMock.mockResolvedValue(makeResponse(500, { error: { message: 'boom' } }));

    const err = await generateStoryImage(baseArgs).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAIImageError);
    expect((err as OpenAIImageError).status).toBe(500);
  });

  it('throws OpenAIImageError when the body has no b64_json', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { data: [{}] }));

    await expect(generateStoryImage(baseArgs)).rejects.toBeInstanceOf(OpenAIImageError);
  });

  it('throws OpenAIImageError with empty api key (no fetch)', async () => {
    await expect(
      generateStoryImage({ ...baseArgs, apiKey: '' }),
    ).rejects.toBeInstanceOf(OpenAIImageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws OpenAIImageError on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const err = await generateStoryImage(baseArgs).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAIImageError);
    expect((err as Error).message).toMatch(/Network error/);
  });
});
