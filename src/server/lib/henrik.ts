/**
 * henrik.ts — HenrikDev API client for Valorant account lookup.
 *
 * Docs: https://docs.henrikdev.xyz/
 * Base URL: https://api.henrikdev.xyz
 *
 * Retry policy: 5xx → retry up to 2 times with random jitter.
 * 429 → throw immediately with retryAfter from Retry-After header.
 */

import { z } from 'zod';
import logger from './log.ts';
import { henrikQueue, type Priority } from './henrik-queue.ts';

export type { Priority } from './henrik-queue.ts';

// ─── Error types ─────────────────────────────────────────────────────────────

export class HenrikError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HenrikError';
  }
}

export class HenrikNotFoundError extends HenrikError {
  constructor() {
    super('Riot account not found');
    this.name = 'HenrikNotFoundError';
  }
}

export class HenrikInactiveAccountError extends HenrikError {
  constructor() {
    super('Henrik cannot enrich — account exists but has no recent match data');
    this.name = 'HenrikInactiveAccountError';
  }
}

export class HenrikRateLimitError extends HenrikError {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(`Henrik API rate limited — retry after ${retryAfter}s`);
    this.name = 'HenrikRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class HenrikUpstreamError extends HenrikError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Henrik upstream error ${status}: ${message}`);
    this.name = 'HenrikUpstreamError';
    this.status = status;
  }
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const AccountDataSchema = z.object({
  puuid: z.string(),
  region: z.string(),
  account_level: z.number().optional(),
  name: z.string(),
  tag: z.string(),
  card: z.union([
    z.string(),
    z.object({
      id: z.string().optional(),
      small: z.string().url().optional(),
      large: z.string().url().optional(),
      wide: z.string().url().optional(),
    }),
  ]).nullish(),
  last_update: z.string().optional(),
});

const AccountResponseSchema = z.object({
  status: z.number(),
  data: AccountDataSchema,
});

export interface RiotAccount {
  puuid: string;
  name: string;
  tag: string;
  region: string;
  cardId: string | null;
}

export function extractCardId(card: unknown): string | null {
  if (typeof card === 'string') return card;
  if (card && typeof card === 'object' && 'id' in card && typeof (card as Record<string, unknown>).id === 'string') return (card as Record<string, unknown>).id as string;
  return null;
}

// ─── Token-bucket rate limiter ────────────────────────────────────────────────
// Henrik free tier: observed 429s even at 20/min. Drop to 10/min for headroom.
// 60 calls per scan tick → 360s ≈ 6 min; fits in 30-min cron interval.

const TOKENS_PER_MINUTE = 10;
const BURST = 1;
const TOKEN_REFILL_MS = 60_000 / TOKENS_PER_MINUTE; // 6000ms per token

let _tokens = BURST;
let _lastRefill = Date.now();

/**
 * Global lockout timestamp (ms). Set when a 429 response includes Retry-After.
 * All acquireToken calls wait until this timestamp before proceeding.
 */
let _blockedUntilMs = 0;

/** Reset token bucket state — for tests only. */
export function __resetTokenBucketForTest(
  opts: { tokens?: number; now?: number } = {},
): void {
  _tokens = opts.tokens ?? BURST;
  _lastRefill = opts.now ?? Date.now();
}

/** Reset the 429 lockout block — for tests only. */
export function __resetBlockUntilForTest(): void {
  _blockedUntilMs = 0;
}

/**
 * Acquire a token from the bucket before each HTTP call.
 * Accepts injectable `now` and `sleep` for deterministic testing.
 * If a Retry-After lockout is active, sleeps until it expires first.
 */
export async function acquireToken(
  nowFn: () => number = Date.now,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  while (true) {
    const now = nowFn();
    if (now < _blockedUntilMs) {
      await sleepFn(_blockedUntilMs - now + 50);
      continue;
    }
    const elapsed = now - _lastRefill;
    if (elapsed >= TOKEN_REFILL_MS) {
      const refill = Math.floor(elapsed / TOKEN_REFILL_MS);
      _tokens = Math.min(BURST, _tokens + refill);
      _lastRefill = _lastRefill + refill * TOKEN_REFILL_MS;
    }
    if (_tokens > 0) {
      _tokens -= 1;
      return;
    }
    // Wait until the next token arrives
    const waitMs = TOKEN_REFILL_MS - (nowFn() - _lastRefill);
    await sleepFn(Math.max(50, waitMs));
  }
}

// ─── Client internals ────────────────────────────────────────────────────────

const BASE_URL = 'https://api.henrikdev.xyz';

function makeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const key = process.env['HENRIK_API_KEY'];
  if (key) {
    headers['Authorization'] = key;
  }
  return headers;
}

function jitter(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * baseMs);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  endpoint: string,
  parseResponse: (json: unknown) => T,
  maxRetries = 2,
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const headers = makeHeaders();

  let attempt = 0;

  while (true) {
    await acquireToken();

    const start = Date.now();
    let response: Response;

    try {
      response = await globalThis.fetch(url, { headers });
    } catch (err) {
      throw new HenrikError(`Network error: ${(err as Error).message}`);
    }

    const duration_ms = Date.now() - start;
    const status = response.status;

    logger.info({ module: 'henrik', endpoint, status, duration_ms }, 'Henrik API request');

    if (status === 200) {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new HenrikError('Malformed JSON response from Henrik API');
      }

      return parseResponse(json);
    }

    if (status === 404) {
      let errorCode: number | undefined;
      try {
        const body = await response.json() as { errors?: Array<{ code?: number }> };
        errorCode = body?.errors?.[0]?.code;
      } catch {
        // ignore parse errors — fall through to HenrikNotFoundError
      }
      if (errorCode === 24) {
        throw new HenrikInactiveAccountError();
      }
      throw new HenrikNotFoundError();
    }

    if (status === 429) {
      const retryAfterHeader = response.headers.get('retry-after') ?? response.headers.get('Retry-After');
      const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const retryAfter = isNaN(parsed) ? 60 : parsed;
      _blockedUntilMs = Date.now() + retryAfter * 1000;
      throw new HenrikRateLimitError(retryAfter);
    }

    if (status >= 500) {
      if (attempt < maxRetries) {
        attempt++;
        const delay = jitter(500 * attempt);
        logger.warn({ module: 'henrik', endpoint, status, attempt, delay_ms: delay }, 'Henrik 5xx — retrying');
        await sleep(delay);
        continue;
      }

      let message = `HTTP ${status}`;
      try {
        const body = await response.text();
        message = body.slice(0, 200);
      } catch {
        // ignore
      }
      throw new HenrikUpstreamError(status, message);
    }

    // Unexpected non-success status
    throw new HenrikError(`Unexpected HTTP ${status} from Henrik API`);
  }
}

function parseAccountResponse(json: unknown): RiotAccount {
  const parsed = AccountResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new HenrikError(`Unexpected Henrik response shape: ${parsed.error.message}`);
  }
  const { data } = parsed.data;
  return {
    puuid: data.puuid,
    name: data.name,
    tag: data.tag,
    region: data.region,
    cardId: extractCardId(data.card),
  };
}

// Legacy v3 schemas removed in Slice B (#53) — no remaining consumers.

// ─── Zod schemas for v4 matches endpoint ─────────────────────────────────────

/**
 * V4 match metadata — queue is an object with an `id` string field.
 * Map is an object with a `name` field.
 */
const MatchMetadataV4Schema = z.object({
  match_id: z.string(),
  platform: z.string().optional(),
  region: z.string().optional(),
  queue: z.object({ id: z.string() }).passthrough().optional(),
  map: z.object({ name: z.string() }).passthrough().optional(),
  started_at: z.string().optional(),
  game_length_in_ms: z.number().optional(),
  is_completed: z.boolean().optional(),
}).passthrough();

const PlayerV4Schema = z.object({
  puuid: z.string(),
  name: z.string().optional(),
  tag: z.string().optional(),
  team_id: z.string().optional(),
  platform: z.string().optional(),
  agent: z.object({ id: z.string().optional(), name: z.string() }).passthrough().optional(),
  tier: z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough().optional(),
  stats: z.object({
    kills: z.number(),
    deaths: z.number(),
    assists: z.number(),
    score: z.number().optional(),
    headshots: z.number().optional(),
    bodyshots: z.number().optional(),
    legshots: z.number().optional(),
    damage: z.object({ dealt: z.number().optional(), received: z.number().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const TeamV4Schema = z.object({
  team_id: z.string(),
  won: z.boolean(),
  rounds: z.object({ won: z.number(), lost: z.number() }).passthrough().optional(),
}).passthrough();

const KillV4Schema = z.object({
  round: z.number().optional(),
  time_in_round_in_ms: z.number().optional(),
  time_in_match_in_ms: z.number().optional(),
  killer: z.object({ puuid: z.string().optional(), name: z.string().optional(), tag: z.string().optional(), team: z.string().optional() }).passthrough().optional(),
  victim: z.object({ puuid: z.string().optional(), name: z.string().optional(), tag: z.string().optional(), team: z.string().optional() }).passthrough().optional(),
  assistants: z.unknown().optional(),
  weapon: z.object({ id: z.string().nullable().optional(), name: z.string().nullable().optional(), type: z.string().nullable().optional() }).passthrough().optional(),
  location: z.object({ x: z.number().optional(), y: z.number().optional() }).passthrough().optional(),
}).passthrough();

const RoundV4Schema = z.object({
  id: z.number().optional(),
  result: z.string().optional(),
  ceremony: z.string().optional(),
  winning_team: z.string().nullable().optional(),
  plant: z.unknown().nullable().optional(),
  defuse: z.unknown().nullable().optional(),
  stats: z.array(z.unknown()).default([]),
}).passthrough();

export type HenrikRoundV4 = z.infer<typeof RoundV4Schema>;

export const HenrikMatchV4Schema = z.object({
  metadata: MatchMetadataV4Schema,
  players: z.array(PlayerV4Schema).default([]),
  teams: z.array(TeamV4Schema).default([]),
  rounds: z.array(RoundV4Schema).default([]),
  kills: z.array(KillV4Schema).default([]),
}).passthrough();

export type HenrikMatchV4 = z.infer<typeof HenrikMatchV4Schema>;
export type HenrikPlayerV4 = z.infer<typeof PlayerV4Schema>;
export type HenrikKillV4 = z.infer<typeof KillV4Schema>;

// Per-element parse: validate each match individually so a single anomalous
// match (e.g. Henrik returning a nullable field as the wrong type) does not
// fail the whole batch. The bad match is logged and dropped; survivors are
// persisted normally. This prevents a flaky Henrik response from causing
// total ingestion blackout for a user every 15 min until the bad match rolls
// off the size window.
const MatchesV4ResponseSchema = z.object({
  status: z.number(),
  data: z.array(z.unknown()),
});

// ─── Zod schemas for v3 MMR endpoint ─────────────────────────────────────────

const MmrTierSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const MmrCurrentSchema = z.object({
  tier: MmrTierSchema,
  rr: z.number(),
  last_change: z.number(),
  elo: z.number().optional(),
  rank_protection_shields: z.number().optional(),
  leaderboard_placement: z.unknown().optional(),
  games_needed_for_rating: z.number().optional(),
}).passthrough();

const MmrPeakSchema = z.object({
  tier: MmrTierSchema,
  rr: z.number(),
  season: z.object({ short: z.string() }).passthrough().optional(),
  ranking_schema: z.string().optional(),
}).passthrough().nullable();

const MmrDataSchema = z.object({
  account: z.unknown().optional(),
  current: MmrCurrentSchema,
  peak: MmrPeakSchema.optional(),
  seasonal: z.array(z.unknown()).optional(),
}).passthrough();

const MmrResponseSchema = z.object({
  status: z.number(),
  data: MmrDataSchema,
});

/** Typed MMR result returned by getMmr / getMmrByPuuid */
export interface HenrikMmr {
  current: {
    tier: { id: number; name: string };
    rr: number;
    last_change: number;
  };
  peak: {
    tier: { id: number; name: string };
    rr: number;
    season: string | null;
  } | null;
}

function parseMmrResponse(json: unknown): HenrikMmr {
  const parsed = MmrResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new HenrikError(`Unexpected Henrik MMR response shape: ${parsed.error.message}`);
  }
  const { data } = parsed.data;
  return {
    current: {
      tier: data.current.tier,
      rr: data.current.rr,
      last_change: data.current.last_change,
    },
    peak: data.peak
      ? {
          tier: data.peak.tier,
          rr: data.peak.rr,
          season: data.peak.season?.short ?? null,
        }
      : null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a Riot account by name + tag.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function validateAccount(
  name: string,
  tag: string,
  opts?: { priority?: Priority },
): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  return henrikQueue.enqueue({
    key: endpoint,
    priority: opts?.priority ?? 'background',
    fn: () => fetchWithRetry(endpoint, parseAccountResponse),
  });
}

/**
 * Look up a Riot account by PUUID.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function getAccountByPuuid(
  puuid: string,
  opts?: { priority?: Priority },
): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/by-puuid/account/${encodeURIComponent(puuid)}`;
  return henrikQueue.enqueue({
    key: endpoint,
    priority: opts?.priority ?? 'background',
    fn: () => fetchWithRetry(endpoint, parseAccountResponse),
  });
}

/**
 * Get recent matches for a player by PUUID.
 * Endpoint: GET /valorant/v4/by-puuid/matches/{region}/{platform}/{puuid}?size=N
 *
 * DO NOT pass mode= query — returns 0 results for console. Caller filters by metadata.queue.id.
 */
export async function getMatches(
  puuid: string,
  region: string,
  opts?: { platform?: 'pc' | 'console'; size?: number; priority?: Priority },
): Promise<HenrikMatchV4[]> {
  const platform = opts?.platform ?? 'console';
  const size = opts?.size ?? 5;
  const endpoint = `/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}?size=${size}`;
  return henrikQueue.enqueue({
    key: endpoint,
    priority: opts?.priority ?? 'background',
    fn: () => fetchWithRetry(endpoint, (json) => {
      const parsed = MatchesV4ResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new HenrikError(`Unexpected Henrik matches response shape: ${parsed.error.message}`);
      }
      const matches: HenrikMatchV4[] = [];
      for (let i = 0; i < parsed.data.data.length; i++) {
        const raw = parsed.data.data[i];
        const match = HenrikMatchV4Schema.safeParse(raw);
        if (match.success) {
          matches.push(match.data);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const matchId = ((raw as any)?.metadata?.match_id as string | undefined) ?? null;
          logger.warn(
            { module: 'henrik', endpoint, index: i, match_id: matchId, err: match.error.message },
            'Dropping malformed match from Henrik response — other matches will still ingest',
          );
        }
      }
      return matches;
    }),
  });
}

/**
 * Get MMR for a player by name + tag.
 * Endpoint: GET /valorant/v3/mmr/{region}/{platform}/{name}/{tag}
 * Default platform: 'console'
 */
export async function getMmr(
  name: string,
  tag: string,
  region: string,
  platform: 'pc' | 'console' = 'console',
  opts?: { priority?: Priority },
): Promise<HenrikMmr> {
  const endpoint = `/valorant/v3/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  return henrikQueue.enqueue({
    key: endpoint,
    priority: opts?.priority ?? 'background',
    fn: () => fetchWithRetry(endpoint, parseMmrResponse),
  });
}

/**
 * Get MMR for a player by PUUID.
 * Endpoint: GET /valorant/v3/by-puuid/mmr/{region}/{platform}/{puuid}
 * Default platform: 'console'
 */
export async function getMmrByPuuid(
  puuid: string,
  region: string,
  platform: 'pc' | 'console' = 'console',
  opts?: { priority?: Priority },
): Promise<HenrikMmr> {
  const endpoint = `/valorant/v3/by-puuid/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}`;
  return henrikQueue.enqueue({
    key: endpoint,
    priority: opts?.priority ?? 'background',
    fn: () => fetchWithRetry(endpoint, parseMmrResponse),
  });
}
