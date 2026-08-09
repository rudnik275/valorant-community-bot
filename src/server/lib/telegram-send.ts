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
 *   (b) Retry policy — only a 429 is repeated in place, after its
 *       `retry_after` backoff: Telegram answered, said "not now", and
 *       definitively did not post. A 4xx ≠ 429 ("chat not found", "message
 *       too long") is refused outright — a retry cannot change the answer.
 *       Everything else (network error, timeout, 5xx) is AMBIGUOUS: the
 *       answer never arrived, so the message may already be in the chat, and
 *       repeating it is how the group ends up reading the same event twice.
 *       Those are thrown WITHOUT a retry, and the caller — which knows
 *       whether its item can be safely re-attempted — decides, using
 *       `isAmbiguousSendFailure`. See `classifySendFailure`.
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
 * What a failed send tells us about whether the message reached the chat.
 *
 * The distinction matters because a retry is only ever safe when Telegram
 * ANSWERED and said no. If the answer itself was lost — a dropped socket, a
 * timeout, an aborted fetch — the message may already be sitting in the group,
 * and re-sending it is exactly how the chat ends up reading the same event, or
 * the same weekly digest, twice (owner, 2026-08-09 — the same complaint that
 * forced per-match uniqueness on the publisher).
 *
 *  - 'rejected'     — Telegram answered with a 4xx ≠ 429 ("chat not found",
 *                     "message is too long", "bot was blocked by the user").
 *                     Nothing was posted and nothing ever will be; a retry is
 *                     pointless. Anything that is neither a Telegram answer
 *                     nor a network failure lands here too: it was thrown
 *                     inside this process before the request left it — the
 *                     allowlist guard's `UnauthorizedChatError` and the
 *                     "sendRichMessage not wired" stub are the canonical
 *                     examples — so nothing was posted.
 *  - 'rate_limited' — Telegram answered 429. Also definitively not posted, but
 *                     the same text is accepted after `retry_after`. This is
 *                     the ONLY failure it is safe to repeat in place.
 *  - 'ambiguous'    — no answer at all (network error, timeout, aborted fetch)
 *                     or a 5xx, which means Telegram's own backend broke
 *                     mid-request and may have queued the message before it
 *                     did. The message MAY be in the chat. Callers must treat
 *                     it as "possibly delivered" and never re-send it.
 */
export type SendFailureKind = 'rejected' | 'rate_limited' | 'ambiguous';

/** Ceiling on a 429 backoff — see `classifySendFailure`. */
const MAX_RETRY_AFTER_MS = 30_000;

export interface SendFailure {
  kind: SendFailureKind;
  /** Backoff before the retry. Only meaningful for 'rate_limited'. */
  retryAfterMs: number;
}

export function classifySendFailure(err: unknown): SendFailure {
  const errCode = (err && typeof err === 'object' && 'error_code' in err)
    ? (err as { error_code?: number }).error_code
    : undefined;
  const errMsg = err instanceof Error ? err.message : String(err);

  // 429 arrives as a GrammyError carrying `error_code`. The text fallback is
  // for a sender that only stringifies the API answer, and it matches the
  // answer's own wording rather than the bare digits: a plain `includes('429')`
  // read `Bad Request: can't parse entities … at byte offset 1429` as a rate
  // limit and burned the retry budget on an error no retry can fix.
  const looksRateLimited = errCode === 429
    || /too many requests/i.test(errMsg)
    || /\bretry[_ ]after\b/i.test(errMsg);
  if (looksRateLimited) {
    const retryAfterSec = (err && typeof err === 'object' && 'parameters' in err)
      ? ((err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5)
      : 5;
    // Cap the wait: the caller is blocked for the whole backoff, and for the
    // publisher that is time spent with an event group claimed but unsent, so a
    // pathological `retry_after` would widen the window in which a crash loses
    // it. Past the cap the next tick re-attempts anyway.
    return { kind: 'rate_limited', retryAfterMs: Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS) };
  }

  if (typeof errCode === 'number' && errCode >= 500 && errCode < 600) {
    return { kind: 'ambiguous', retryAfterMs: 0 };
  }

  // grammY's HttpError carries no error_code and reads "Network request for
  // 'sendMessage' failed!"; raw undici/node causes surface as ECONN* /
  // ETIMEDOUT / EAI_AGAIN / AbortError. Either way the HTTP answer never came.
  const noAnswer = errCode === undefined
    && /network|timeout|fetch|abort|socket|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(errMsg);
  if (noAnswer) return { kind: 'ambiguous', retryAfterMs: 0 };

  return { kind: 'rejected', retryAfterMs: 0 };
}

/**
 * True when the failure leaves it unknown whether the message reached the
 * chat. Callers use it to choose between "safe to re-attempt next tick" and
 * "may already be in the chat — close the item out instead". It works on a raw
 * error too, so callers that send WITHOUT going through this module's retry
 * loops get the same verdict.
 */
export function isAmbiguousSendFailure(err: unknown): boolean {
  return classifySendFailure(err).kind === 'ambiguous';
}

/**
 * Decide what happens after a failed attempt: log it, and — for the one
 * failure that is safe to repeat — sleep out the backoff. Returns true when
 * the caller should try again.
 *
 * Shared by all three send loops so the "which failures may be repeated"
 * decision exists exactly once. They previously differed only in their log
 * label, and each one independently re-derived the error code.
 */
async function shouldRetryAfterFailure(
  err: unknown,
  attempt: number,
  chatId: number,
  logContext: Record<string, unknown> | undefined,
): Promise<boolean> {
  const { kind, retryAfterMs } = classifySendFailure(err);

  if (kind === 'rate_limited' && attempt === 0) {
    logger.warn(
      { module: 'telegram_send', chat_id: chatId, retry_after_ms: retryAfterMs, kind, ...logContext },
      'Telegram rate-limited the send — retrying after the backoff',
    );
    await sleep(retryAfterMs);
    return true;
  }

  if (kind === 'ambiguous') {
    // We never learned whether Telegram accepted it, so the caller — which
    // knows whether its item can be safely re-attempted — owns the decision.
    // Retrying here is precisely how the group read the same event twice.
    logger.error(
      { module: 'telegram_send', chat_id: chatId, kind, err, ...logContext },
      'Telegram send got no answer — the message MAY already be in the chat; not retrying',
    );
  } else {
    logger.warn(
      { module: 'telegram_send', chat_id: chatId, kind, err, ...logContext },
      'Telegram refused the send — not retryable',
    );
  }
  return false;
}

/**
 * Core send with retry. Shared by `send` and `sendExempt`.
 * Up to 2 attempts, and only a 429 earns the second one — see
 * `classifySendFailure` for why nothing else may be repeated. The last error
 * is thrown either way, so the caller can classify it too.
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
      if (await shouldRetryAfterFailure(err, attempt, chatId, logContext)) continue;
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
 * Core photo send with retry. Same policy as `sendWithRetry` (it shares
 * `shouldRetryAfterFailure`): a 429 is repeated after its backoff, everything
 * else is thrown for the caller to classify.
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
      if (await shouldRetryAfterFailure(err, attempt, chatId, { photo: true, ...logContext })) continue;
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
 * Up to 2 attempts, and only a 429 earns the second one. Anything else is
 * thrown immediately — see `classifySendFailure` / `isAmbiguousSendFailure`.
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
      if (await shouldRetryAfterFailure(err, attempt, chatId, logContext)) continue;
      break;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Guard-only send — for callers that own their own retry
// ---------------------------------------------------------------------------

/**
 * Allowlist guard and nothing else: ONE attempt, no backoff, the API error
 * thrown straight through.
 *
 * This is what a caller that already has a retry layer must use. The publisher
 * wraps its injected sender in `sendWithRetryFn` (it has to — the retry has to
 * sit inside the claim/rollback logic that decides whether an event may be
 * re-attempted), and this shim used to delegate to `send`, which retries too.
 * So one 429 was retried by both layers: four API attempts and up to 90 s of
 * sleep in a single tick, all while the event group was claimed but unsent.
 * The doc-comment even asserted the opposite of what the code did.
 */
export async function safeSendMessage(
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
  return api.sendMessage(chatId, text, opts);
}
