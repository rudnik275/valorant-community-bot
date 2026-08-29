/**
 * resolve-account.test.ts — the account-endpoint fallback.
 *
 * The valuable cases here are the NEGATIVE ones: a nick that does not exist
 * must keep failing, because that refusal is what the join gate stands on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAccount,
  HenrikNotFoundError,
  HenrikInactiveAccountError,
  HenrikRateLimitError,
  __resetBlockUntilForTest,
  __resetTokenBucketForTest,
} from './henrik.ts';

vi.mock('./log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PUUID = 'f9408c00-98c2-5da6-815c-8ea65a600417';

/** A v4 matches payload whose roster contains the player we asked about. */
function matchesPayloadWith(name: string, tag: string) {
  return {
    status: 200,
    data: [{
      metadata: { match_id: 'm1', started_at: '2026-08-29T09:12:55.523Z', queue: { id: 'competitive' } },
      players: [
        { puuid: 'someone-else', name: 'Other', tag: '111', team_id: 'Red' },
        { puuid: PUUID, name, tag, team_id: 'Blue' },
      ],
      teams: [],
      kills: [],
    }],
  };
}

/** vitest mocks lack `preconnect`; the cast keeps the mock assignable. */
function asFetch(m: ReturnType<typeof vi.fn>): typeof fetch {
  return m as unknown as typeof fetch;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
}

const ACCOUNT_INACTIVE = { status: 404, body: { errors: [{ code: 24 }] } };
const ACCOUNT_MISSING = { status: 404, body: { errors: [{ code: 0 }] } };

describe('resolveAccount', () => {
  beforeEach(() => {
    __resetBlockUntilForTest();
    // Without a full bucket the queue paces requests and every fallback test
    // sits out its own rate limit.
    __resetTokenBucketForTest({ tokens: 30 });
    process.env['HENRIK_API_KEY'] = 'test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the account directly when the account endpoint works', async () => {
    globalThis.fetch = asFetch(mockFetchSequence([{
      status: 200,
      body: { status: 200, data: { puuid: PUUID, name: 'kapralv', tag: '9793', region: 'eu' } },
    }]));

    const acc = await resolveAccount('kapralv', '9793');

    expect(acc.puuid).toBe(PUUID);
    // Happy path must not spend a second request on the fallback.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('recovers the puuid from match data when the account is called inactive', async () => {
    globalThis.fetch = asFetch(mockFetchSequence([
      ACCOUNT_INACTIVE,
      { status: 200, body: matchesPayloadWith('kapralv', '9793') },
    ]));

    const acc = await resolveAccount('kapralv', '9793');

    expect(acc.puuid).toBe(PUUID);
    expect(acc.name).toBe('kapralv');
    expect(acc.tag).toBe('9793');
    expect(acc.region).toBe('eu');
    // The card lives on the account record that just failed us.
    expect(acc.cardId).toBeNull();
  });

  it('matches the roster entry case-insensitively', async () => {
    globalThis.fetch = asFetch(mockFetchSequence([
      ACCOUNT_INACTIVE,
      { status: 200, body: matchesPayloadWith('KapralV', '9793') },
    ]));

    await expect(resolveAccount('kapralv', '9793')).resolves.toMatchObject({ puuid: PUUID });
  });

  it('does NOT fall back when the nick simply does not exist', async () => {
    // The whole join gate rests on this: a definitive not-found must stay
    // not-found, or a typo could wander into someone else's match roster.
    const fetchMock = mockFetchSequence([ACCOUNT_MISSING]);
    globalThis.fetch = asFetch(fetchMock);

    await expect(resolveAccount('Kapral', '009')).rejects.toBeInstanceOf(HenrikNotFoundError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original inactive error when the player is absent from the roster', async () => {
    globalThis.fetch = asFetch(mockFetchSequence([
      ACCOUNT_INACTIVE,
      { status: 200, body: matchesPayloadWith('SomebodyElse', '000') },
    ]));

    await expect(resolveAccount('kapralv', '9793'))
      .rejects.toBeInstanceOf(HenrikInactiveAccountError);
  });

  it('rethrows the original inactive error when the fallback itself fails', async () => {
    // A 429 on the fallback must not masquerade as "account not found" — the
    // caller decides what to do with an inactive account, as it always has.
    globalThis.fetch = asFetch(mockFetchSequence([ACCOUNT_INACTIVE, { status: 429, body: {} }]));

    await expect(resolveAccount('kapralv', '9793'))
      .rejects.toBeInstanceOf(HenrikInactiveAccountError);
  });

  it('propagates a rate limit from the account endpoint untouched', async () => {
    // Must stay a HenrikRateLimitError so onboard admits on trust (#350)
    // instead of treating it as a bad nick.
    globalThis.fetch = asFetch(mockFetchSequence([{ status: 429, body: {} }]));

    await expect(resolveAccount('kapralv', '9793'))
      .rejects.toBeInstanceOf(HenrikRateLimitError);
  });
});
