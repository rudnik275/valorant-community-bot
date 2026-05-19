/**
 * telegram-send.ts — Single outbound-Telegram send concern.
 *
 * ALL outbound Telegram sendMessage calls in this codebase route through this
 * module. It owns three responsibilities in one place:
 *
 *   (a) Allowlist guard — non-allowlisted chats are rejected with
 *       `UnauthorizedChatError` before any API call is made. This is the
 *       defence-in-depth layer that ensures no message is sent to an
 *       unauthorised chat even if scope-guard middleware is bypassed.
 *
 *   (b) Retry / backoff policy — transient errors (Telegram 429, 5xx,
 *       and network-layer failures) are retried once after a backoff:
 *       429 → retry_after param (default 5 s); 5xx / network → 2 s.
 *       Durable errors (4xx ≠ 429: "chat not found", "message too long",
 *       etc.) are NOT retried — the caller must decide how to park the
 *       failed item.  After both attempts fail, the last error is thrown so
 *       the caller can track failure counts / change item status.
 *
 *   (c) Named exempt path (`sendExempt`) — owner-DM sends and confirmed
 *       primary-chat posts that must bypass the allowlist check. The risk
 *       model (from src/server/bot/test-commands.ts:13-20) applies here:
 *       the exempt path is ONLY correct when the destination is either the
 *       bot-owner's own DM (verified by `isOwner()` in the call site) or
 *       `TELEGRAM_PRIMARY_CHAT_ID` (an already-authorised group). Using
 *       `sendExempt` for an arbitrary chat would defeat the guard. Call
 *       sites must document why the exemption is valid, just like the old
 *       bypass comment did.
 *
 * The retry logic previously lived inline in `src/server/publisher/loop.ts`.
 * Moving it here means every caller (publisher, digest loops, bot commands)
 * gets the same durable-vs-transient classification without copy-paste.
 */

import { InputFile } from 'grammy';
import type { Api } from 'grammy';
import logger from './log.ts';
import { isAllowedChat } from './scope.ts';

// Re-export so callers can import from one place.
export { isAllowedChat };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnauthorizedChatError extends Error {
  constructor(chatId: number) {
    super(`Chat ${chatId} is not in the allowed chat list`);
    this.name = 'UnauthorizedChatError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export type SendOpts = Parameters<Api['sendMessage']>[2];
export type SendPhotoOpts = Parameters<Api['sendPhoto']>[2];

let sleepFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Override the sleep implementation — for tests only. */
export function _setSleepFnForTest(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

/** Reset to the real setTimeout-based sleep — for tests only. */
export function _resetSleepFnForTest(): void {
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function sleep(ms: number): Promise<void> {
  return sleepFn(ms);
}

/**
 * Classify a Telegram API error to decide whether to retry.
 * Returns { isTransient, retryAfterMs }.
 */
function classifyError(err: unknown): { isTransient: boolean; retryAfterMs: number } {
  const errCode = (err && typeof err === 'object' && 'error_code' in err)
    ? (err as { error_code?: number }).error_code
    : undefined;
  const errMsg = err instanceof Error ? err.message : String(err);

  const is429 = errCode === 429 || (errMsg ?? '').includes('429');
  const is5xx = typeof errCode === 'number' && errCode >= 500 && errCode < 600;
  // grammY wraps fetch errors with no error_code; treat as transient.
  const isNetwork = errCode === undefined && !is429 && /network|timeout|fetch|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(errMsg);
  const isTransient = is429 || is5xx || isNetwork;

  let retryAfterMs: number;
  if (is429) {
    const retryAfterSec = (err && typeof err === 'object' && 'parameters' in err)
      ? ((err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5)
      : 5;
    retryAfterMs = retryAfterSec * 1000;
  } else {
    retryAfterMs = 2000;
  }

  return { isTransient, retryAfterMs };
}

/**
 * Core send with retry. Shared by `send` and `sendExempt`.
 * Up to 2 attempts. On transient error + first attempt: sleeps then retries.
 * Throws on durable error (any attempt) or transient error after retry.
 */
async function sendWithRetry(
  api: Api,
  chatId: number,
  text: string,
  opts?: SendOpts,
  logContext?: Record<string, unknown>,
): ReturnType<Api['sendMessage']> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.sendMessage(chatId, text, opts);
    } catch (err: unknown) {
      lastErr = err;
      const { isTransient, retryAfterMs } = classifyError(err);

      if (isTransient && attempt === 0) {
        const errCode = (err && typeof err === 'object' && 'error_code' in err)
          ? (err as { error_code?: number }).error_code
          : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        const is429 = errCode === 429 || (errMsg ?? '').includes('429');
        const is5xx = typeof errCode === 'number' && errCode >= 500 && errCode < 600;
        const kind = is429 ? '429' : is5xx ? '5xx' : 'network';

        logger.warn(
          { module: 'telegram_send', chat_id: chatId, retry_after_ms: retryAfterMs, kind, ...logContext },
          'Transient Telegram error — retrying',
        );
        await sleep(retryAfterMs);
        continue;
      }

      // Durable error on any attempt, OR transient after retry — give up.
      break;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a message to an allowlisted chat.
 *
 * Throws `UnauthorizedChatError` for non-allowlisted chats (no API call made).
 * Throws the Telegram API error after exhausting retries for transient failures.
 */
export async function send(
  api: Api,
  chatId: number,
  text: string,
  opts?: SendOpts,
): ReturnType<Api['sendMessage']> {
  if (!isAllowedChat(chatId)) {
    logger.warn(
      { event: 'telegram_send_block', chat_id: chatId },
      'Blocked outbound API call to unauthorized chat',
    );
    throw new UnauthorizedChatError(chatId);
  }
  return sendWithRetry(api, chatId, text, opts);
}

/**
 * Send a message that bypasses the allowlist guard.
 *
 * ONLY valid for:
 *   - The bot owner's own DM (ctx.from.id verified by `isOwner()` at the call
 *     site — the reply lands in the owner's DM, no data can leak elsewhere).
 *   - `TELEGRAM_PRIMARY_CHAT_ID` after explicit owner confirmation (the
 *     congrats callback — destination is the already-authorised group chat).
 *
 * Do NOT call this for arbitrary chats. Document why the exemption applies at
 * every call site. The allowlist guard exists for a reason; exempt calls must
 * carry the risk-model justification in their comments.
 *
 * Still applies the retry/backoff policy for transient errors.
 */
export async function sendExempt(
  api: Api,
  chatId: number,
  text: string,
  opts?: SendOpts,
): ReturnType<Api['sendMessage']> {
  return sendWithRetry(api, chatId, text, opts, { exempt: true });
}

// ---------------------------------------------------------------------------
// Photo send (weekly promo image — #227)
// ---------------------------------------------------------------------------

/**
 * Core photo send with retry. Same 2-attempt transient policy as
 * `sendWithRetry` (it reuses `classifyError`): 429 → retry_after (default
 * 5 s), 5xx / network → 2 s, durable 4xx → throw immediately.
 */
async function sendPhotoWithRetry(
  api: Api,
  chatId: number,
  photo: InputFile,
  opts?: SendPhotoOpts,
  logContext?: Record<string, unknown>,
): ReturnType<Api['sendPhoto']> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.sendPhoto(chatId, photo, opts);
    } catch (err: unknown) {
      lastErr = err;
      const { isTransient, retryAfterMs } = classifyError(err);

      if (isTransient && attempt === 0) {
        const errCode = (err && typeof err === 'object' && 'error_code' in err)
          ? (err as { error_code?: number }).error_code
          : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        const is429 = errCode === 429 || (errMsg ?? '').includes('429');
        const is5xx = typeof errCode === 'number' && errCode >= 500 && errCode < 600;
        const kind = is429 ? '429' : is5xx ? '5xx' : 'network';

        logger.warn(
          { module: 'telegram_send', chat_id: chatId, retry_after_ms: retryAfterMs, kind, photo: true, ...logContext },
          'Transient Telegram error (sendPhoto) — retrying',
        );
        await sleep(retryAfterMs);
        continue;
      }

      // Durable error on any attempt, OR transient after retry — give up.
      break;
    }
  }

  throw lastErr;
}

/**
 * Send a photo that bypasses the allowlist guard.
 *
 * Same exemption risk-model as `sendExempt` (see its doc-comment): ONLY
 * valid when the destination is either the bot-owner's own DM (verified by
 * `isOwner()` at the call site — used by `/test_digest_image`) or
 * `TELEGRAM_PRIMARY_CHAT_ID` (the already-authorised group — the weekly
 * promo-image photo reply on the digest message, #227). The weekly digest
 * text already posts to that same primary chat via the exempt path; the
 * photo reply is purely additive and lands on the message we just sent.
 * Do NOT call this for arbitrary chats.
 *
 * `photo` is an in-memory `InputFile(buffer, name)`. Reply via
 * `opts.reply_parameters = { message_id }`. Still applies the
 * retry/backoff policy for transient errors.
 */
export async function sendPhotoExempt(
  api: Api,
  chatId: number,
  photo: InputFile,
  opts?: SendPhotoOpts,
): ReturnType<Api['sendPhoto']> {
  return sendPhotoWithRetry(api, chatId, photo, opts, { exempt: true });
}

export { InputFile };

// ---------------------------------------------------------------------------
// Retry helper for injected send functions (publisher/digest loops)
// ---------------------------------------------------------------------------

export type InjectedSendFn = (
  chatId: number,
  text: string,
  opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
) => Promise<{ message_id: number }>;

/**
 * Wrap any injected send function with the same transient-retry policy used
 * by `send` and `sendExempt`. This is the entry point for publisher/loop.ts
 * which receives `sendMessage` as an injected dependency (already guarded by
 * the allowlist via the closure in index.ts).
 *
 * Up to 2 attempts. On transient error + first attempt: sleep then retry.
 * On durable error (any attempt) or transient after retry: throw.
 *
 * @param fn     The injected sendMessage function to wrap.
 * @param chatId Chat to send to (passed through to fn, used only for logging).
 * @param text   Message text.
 * @param opts   Send options.
 */
export async function sendWithRetryFn(
  fn: InjectedSendFn,
  chatId: number,
  text: string,
  opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
  logContext?: Record<string, unknown>,
): Promise<{ message_id: number }> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fn(chatId, text, opts);
    } catch (err: unknown) {
      lastErr = err;
      const { isTransient, retryAfterMs } = classifyError(err);

      if (isTransient && attempt === 0) {
        const errCode = (err && typeof err === 'object' && 'error_code' in err)
          ? (err as { error_code?: number }).error_code
          : undefined;
        const errMsg = err instanceof Error ? err.message : String(err);
        const is429 = errCode === 429 || (errMsg ?? '').includes('429');
        const is5xx = typeof errCode === 'number' && errCode >= 500 && errCode < 600;
        const kind = is429 ? '429' : is5xx ? '5xx' : 'network';

        logger.warn(
          { module: 'telegram_send', chat_id: chatId, retry_after_ms: retryAfterMs, kind, ...logContext },
          'Transient Telegram error — retrying',
        );
        await sleep(retryAfterMs);
        continue;
      }

      // Durable error on any attempt, OR transient after retry — give up.
      break;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Legacy shim — keeps `safeSendMessage` semantics for existing callers
// ---------------------------------------------------------------------------

/**
 * @deprecated Prefer `send` from `telegram-send.ts` directly.
 * Thin shim kept so callers that import `safeSendMessage` from the old path
 * (`./safe-telegram`) continue to work without churn. Behaviour identical:
 * allowlist-guarded, no retry (the publisher loop now uses `send` which adds
 * retry; callers that only want the guard without retry can call this).
 *
 * NOTE: This shim does NOT add retry — it just guards. The publisher should
 * use the `send` export which includes retry. Existing `safeSendMessage` call
 * sites in index.ts pass through the guard; the publisher loop calls `send`.
 */
export async function safeSendMessage(
  api: Api,
  chatId: number,
  text: string,
  opts?: SendOpts,
): ReturnType<Api['sendMessage']> {
  return send(api, chatId, text, opts);
}
