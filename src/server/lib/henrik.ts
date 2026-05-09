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

async function fetchWithRetry(endpoint: string, maxRetries = 2): Promise<RiotAccount> {
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate a Riot account by name + tag.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function validateAccount(name: string, tag: string): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
  return fetchWithRetry(endpoint);
}

/**
 * Look up a Riot account by PUUID.
 * Returns parsed account data or throws typed HenrikError.
 */
export async function getAccountByPuuid(puuid: string): Promise<RiotAccount> {
  const endpoint = `/valorant/v1/by-puuid/account/${encodeURIComponent(puuid)}`;
  return fetchWithRetry(endpoint);
}
