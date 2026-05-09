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

// ─── Legacy v3 match schema (kept for derive.ts / Slice B migration) ─────────
//
// TODO Slice A #52: remove this block once Slice B (#53) migrates derive.ts to v4 schema.

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

/** @deprecated — v3 PC-only shape; use HenrikMatchV4 for new code. Slice B (#53) will migrate. */
export type HenrikMatch = z.infer<typeof HenrikMatchSchema>;
/** @deprecated use HenrikKillV4 for new code */
export type HenrikKillEvent = z.infer<typeof KillEventSchema>;
/** @deprecated use HenrikPlayerV4 for new code */
export type HenrikPlayer = z.infer<typeof PlayerSchema>;

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
  weapon: z.object({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional() }).passthrough().optional(),
  location: z.object({ x: z.number().optional(), y: z.number().optional() }).passthrough().optional(),
}).passthrough();

export const HenrikMatchV4Schema = z.object({
  metadata: MatchMetadataV4Schema,
  players: z.array(PlayerV4Schema).default([]),
  teams: z.array(TeamV4Schema).default([]),
  rounds: z.array(z.unknown()).default([]),
  kills: z.array(KillV4Schema).default([]),
}).passthrough();

export type HenrikMatchV4 = z.infer<typeof HenrikMatchV4Schema>;
export type HenrikPlayerV4 = z.infer<typeof PlayerV4Schema>;
export type HenrikKillV4 = z.infer<typeof KillV4Schema>;

const MatchesV4ResponseSchema = z.object({
  status: z.number(),
  data: z.array(HenrikMatchV4Schema),
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
 * Get recent matches for a player by PUUID.
 * Endpoint: GET /valorant/v4/by-puuid/matches/{region}/{platform}/{puuid}?size=N
 *
 * DO NOT pass mode= query — returns 0 results for console. Caller filters by metadata.queue.id.
 */
export async function getMatches(
  puuid: string,
  region: string,
  opts?: { platform?: 'pc' | 'console'; size?: number },
): Promise<HenrikMatchV4[]> {
  const platform = opts?.platform ?? 'console';
  const size = opts?.size ?? 5;
  const endpoint = `/valorant/v4/by-puuid/matches/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}?size=${size}`;
  return fetchWithRetry(endpoint, (json) => {
    const parsed = MatchesV4ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HenrikError(`Unexpected Henrik matches response shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
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
): Promise<HenrikMmr> {
  const endpoint = `/valorant/v3/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  return fetchWithRetry(endpoint, parseMmrResponse);
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
): Promise<HenrikMmr> {
  const endpoint = `/valorant/v3/by-puuid/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(puuid)}`;
  return fetchWithRetry(endpoint, parseMmrResponse);
}
