/**
 * run.ts — orchestrate one weekly-promo-image generation (#227).
 *
 * Resolve the agent/map reference PNGs → build the prompt (verbatim
 * STORY_PROMPT + plain-text digest) → call `generateStoryImage()` → return
 * the PNG Buffer.
 *
 * This module deliberately does NOT swallow errors. Two distinct outcomes:
 *   - a reference PNG is missing (operator hasn't added that agent/map yet,
 *     or there were no matches so topAgent/topMap is null) → return `null`
 *     so the caller can warn + post text-only. This is an expected,
 *     non-exceptional state, not a failure.
 *   - OpenAI / sharp failure → the `OpenAIImageError` propagates. The caller
 *     (prepare tick) owns the retry/give-up policy (issue #227 §3).
 */

import { resolveAgentImage, resolveMapImage } from './agent-map-fixtures.ts';
import { generateStoryImage } from './openai-image.ts';
import { appendDigestText } from './prompt.ts';
import logger from '../lib/log.ts';

export interface RunStoryArgs {
  /** Top agent display name from buildDigest (e.g. "Jett"). May be null. */
  topAgent: string | null;
  /** Top map display name from buildDigest (e.g. "Ascent"). May be null. */
  topMap: string | null;
  /** The exact digest text (HTML) that will be posted to the chat. */
  digestText: string;
  /** OpenAI API key. */
  apiKey: string;
  signal?: AbortSignal;
}

export interface RunStoryResult {
  /** The normalised 1080×1920 PNG, or null when references were missing. */
  buffer: Buffer | null;
  /** Set when buffer is null — why no image (for the caller's warn log). */
  skipReason?: 'missing_agent_ref' | 'missing_map_ref';
}

/**
 * Resolve refs → generate → Buffer. Returns `{ buffer: null, skipReason }`
 * when a reference PNG is absent (caller warns + posts text-only). Throws
 * `OpenAIImageError` on a generation failure (caller retries / gives up).
 */
export async function runStoryGeneration(args: RunStoryArgs): Promise<RunStoryResult> {
  const agentPath = resolveAgentImage(args.topAgent);
  if (!agentPath) {
    logger.warn(
      { module: 'story_run', top_agent: args.topAgent },
      'No agent reference PNG — skipping promo image (text-only digest)',
    );
    return { buffer: null, skipReason: 'missing_agent_ref' };
  }

  const mapPath = resolveMapImage(args.topMap);
  if (!mapPath) {
    logger.warn(
      { module: 'story_run', top_map: args.topMap },
      'No map reference PNG — skipping promo image (text-only digest)',
    );
    return { buffer: null, skipReason: 'missing_map_ref' };
  }

  const buffer = await generateStoryImage({
    agentPath,
    mapPath,
    digestText: appendDigestText(args.digestText),
    apiKey: args.apiKey,
    ...(args.signal ? { signal: args.signal } : {}),
  });

  return { buffer };
}
