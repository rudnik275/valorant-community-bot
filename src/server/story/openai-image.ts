/**
 * openai-image.ts — generate the weekly promo image via OpenAI Images API.
 *
 * `POST https://api.openai.com/v1/images/edits` (multipart) with two
 * reference images (top-agent card + top-map preview) and the verbatim
 * STORY_PROMPT followed by the plain-text digest. Model defaults to
 * `chatgpt-image-latest` (the image model this project has access to) and is
 * overridable via the `OPENAI_IMAGE_MODEL` env var — a 403 "project does not
 * have access to model X" is fixed by setting that var, no code change.
 *
 * Client style mirrors `src/server/lib/henrik.ts`: per-request hard timeout
 * via AbortController + setTimeout cleared in `finally`, `globalThis.fetch`,
 * a typed error base class. NO rate limiter — this is called at most once a
 * week (the Fri 18:45 prepare tick / the `/test_digest_image` owner command).
 *
 * The retry/give-up policy lives in the *caller* (the prepare tick: MAX 2
 * attempts, no delay, then give up silently — issue #227 §3). This module
 * just makes one request and either returns the model's PNG Buffer
 * (native ~2:3 portrait — no crop) or throws `OpenAIImageError`.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp from 'sharp';
import logger from '../lib/log.ts';

// ─── Error type ──────────────────────────────────────────────────────────────

export class OpenAIImageError extends Error {
  /** HTTP status when the failure came from a response (else undefined). */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenAIImageError';
    if (status !== undefined) this.status = status;
  }
}

// ─── Client internals ────────────────────────────────────────────────────────

const ENDPOINT = 'https://api.openai.com/v1/images/edits';
/**
 * `gpt-image-2` (the original #227 placeholder) 403s with "project does not
 * have access to model" on this project; `chatgpt-image-latest` is the image
 * model it does have access to. Overridable via env so a future model bump is
 * an env tweak, not a code change + redeploy.
 */
const DEFAULT_MODEL = process.env['OPENAI_IMAGE_MODEL'] ?? 'chatgpt-image-latest';
/** Tallest portrait size the Images API supports; kept as-is (no crop). */
const DEFAULT_SIZE = '1024x1536';

/**
 * Per-request hard timeout. Mirrors henrik.ts: without it a connection that
 * accepts then never closes hangs forever. Image gen is slow → 120s.
 */
const FETCH_TIMEOUT_MS = 120_000;

interface OpenAIImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; type?: string };
}

/**
 * Generate the weekly promo image.
 *
 * @returns the model's PNG Buffer at its native aspect (no crop).
 * @throws  {OpenAIImageError} on missing key, non-200, malformed body,
 *          network error, or timeout. The caller decides retry/give-up.
 */
export async function generateStoryImage(args: {
  agentPath: string;
  mapPath: string;
  digestText: string;
  apiKey: string;
  model?: string;
  size?: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { agentPath, mapPath, digestText, apiKey } = args;
  const model = args.model ?? DEFAULT_MODEL;
  const size = args.size ?? DEFAULT_SIZE;

  if (!apiKey) {
    throw new OpenAIImageError('OPENAI_API_KEY is empty');
  }

  const [agentBuf, mapBuf] = await Promise.all([
    readFile(agentPath),
    readFile(mapPath),
  ]);

  const form = new FormData();
  form.append('model', model);
  form.append('size', size);
  form.append('prompt', digestText);
  // OpenAI /v1/images/edits accepts multiple `image[]` parts (agent + map).
  form.append(
    'image[]',
    new Blob([new Uint8Array(agentBuf)], { type: 'image/png' }),
    basename(agentPath),
  );
  form.append(
    'image[]',
    new Blob([new Uint8Array(mapBuf)], { type: 'image/png' }),
    basename(mapPath),
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Chain the caller's signal (if any) into our own controller.
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else args.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const start = Date.now();
  let response: Response;
  try {
    response = await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isAbort = (err as Error).name === 'AbortError' || message.includes('aborted');
    throw new OpenAIImageError(`${isAbort ? 'Timeout' : 'Network error'}: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const duration_ms = Date.now() - start;
  const status = response.status;
  logger.info({ module: 'openai_image', status, duration_ms }, 'OpenAI image request');

  if (status === 429) {
    throw new OpenAIImageError('OpenAI rate limited (429)', 429);
  }

  if (status !== 200) {
    let detail = `HTTP ${status}`;
    try {
      const body = (await response.json()) as OpenAIImagesResponse;
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // ignore — fall through with the generic HTTP status detail
    }
    throw new OpenAIImageError(`OpenAI image error ${status}: ${detail}`, status);
  }

  let body: OpenAIImagesResponse;
  try {
    body = (await response.json()) as OpenAIImagesResponse;
  } catch {
    throw new OpenAIImageError('Malformed JSON response from OpenAI');
  }

  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) {
    throw new OpenAIImageError('OpenAI response missing data[0].b64_json');
  }

  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 0) {
    throw new OpenAIImageError('OpenAI returned an empty image');
  }

  // Keep the model's native aspect (~2:3). We used to cover-crop to a strict
  // 9:16 — that was for the dropped Telegram Story format and it shaved ~100px
  // off each side, clipping the left-edge text ("ДАЙДЖЕСТ" → "АЙДЖЕСТ"). A
  // photo reply has no fixed-aspect requirement, so just normalise to PNG and
  // send the full frame the model composed.
  try {
    return await sharp(raw).png().toBuffer();
  } catch (err) {
    throw new OpenAIImageError(
      `sharp failed to normalise the image: ${(err as Error).message ?? String(err)}`,
    );
  }
}
