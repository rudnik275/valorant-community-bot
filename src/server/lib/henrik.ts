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
  card: z.unknown().optional(),
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
      throw new HenrikNotFoundError();
    }

    if (status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
      throw new HenrikRateLimitError(isNaN(retryAfter) ? 60 : retryAfter);
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
  };
}

// ─── Zod schemas for matches endpoint ────────────────────────────────────────

/** Kill event shape from Henrik /v3/matches */
const KillEventSchema = z.object({
  round: z.number(),
  /** killer's team: 'Red' | 'Blue' */
  killer_team: z.string().optional(),
  /** victim's team: 'Red' | 'Blue' */
  victim_team: z.string().optional(),
  /** weapon id, e.g. 'Vandal', 'Fall' */
  damage_weapon_id: z.string().optional(),
  /** attacker puuid */
  killer_puuid: z.string().optional(),
  /** victim puuid */
  victim_puuid: z.string().optional(),
  /** damage type: 'Fall', 'Bullet', etc. */
  damage_type: z.string().optional(),
}).passthrough();

const PlayerSchema = z.object({
  puuid: z.string(),
  team: z.string(),
  character: z.string(),
  stats: z.object({
    kills: z.number(),
    deaths: z.number(),
    assists: z.number(),
  }).passthrough().optional(),
  currenttier: z.number().optional(),
  currenttier_patched: z.string().optional(),
}).passthrough();

const TeamSchema = z.object({
  has_won: z.boolean(),
  rounds_won: z.number().optional(),
  rounds_lost: z.number().optional(),
}).passthrough();

const MatchMetadataSchema = z.object({
  matchid: z.string(),
  mode: z.string(),
  map: z.string(),
  game_start: z.number(),
  rounds_played: z.number().optional(),
}).passthrough();

const MatchPlayersSchema = z.object({
  all_players: z.array(PlayerSchema),
}).passthrough();

const MatchTeamsSchema = z.object({
  red: TeamSchema.optional(),
  blue: TeamSchema.optional(),
}).passthrough();

export const HenrikMatchSchema = z.object({
  metadata: MatchMetadataSchema,
  players: MatchPlayersSchema,
  teams: MatchTeamsSchema,
  kills: z.array(KillEventSchema).default([]),
  rounds: z.array(z.unknown()).default([]),
}).passthrough();

export type HenrikMatch = z.infer<typeof HenrikMatchSchema>;
export type HenrikKillEvent = z.infer<typeof KillEventSchema>;
export type HenrikPlayer = z.infer<typeof PlayerSchema>;

const MatchesResponseSchema = z.object({
  status: z.number(),
  data: z.array(HenrikMatchSchema),
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a Riot account by name + tag.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function validateAccount(name: string, tag: string): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  return fetchWithRetry(endpoint, parseAccountResponse);
}

/**
 * Look up a Riot account by PUUID.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function getAccountByPuuid(puuid: string): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/by-puuid/account/${encodeURIComponent(puuid)}`;
  return fetchWithRetry(endpoint, parseAccountResponse);
}

/**
 * Get recent matches for a player.
 * Endpoint: GET /valorant/v3/matches/{region}/{name}/{tag}?mode=competitive&size=5
 */
export async function getMatches(
  name: string,
  tag: string,
  region: string,
  opts: { mode?: string; size?: number } = {},
): Promise<HenrikMatch[]> {
  const mode = opts.mode ?? 'competitive';
  const size = opts.size ?? 5;
  const endpoint = `/valorant/v3/matches/${encodeURIComponent(region)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?mode=${mode}&size=${size}`;
  return fetchWithRetry(endpoint, (json) => {
    const parsed = MatchesResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HenrikError(`Unexpected Henrik matches response shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  });
}
