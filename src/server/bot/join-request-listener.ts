/**
 * join-request-listener.ts — guard-bot handler for `chat_join_request`
 * (Bot API 10.1).
 *
 * Flow: someone requests to join → Telegram delivers `chat_join_request` with a
 * `query_id` → we have ~10 SECONDS to either show a Mini App
 * (`sendChatJoinRequestWebApp`) or answer outright — so this handler does no DB
 * work and no Henrik calls before responding. The nick is entered in the Mini
 * App, and `POST /api/onboard` is what finally calls
 * `answerChatJoinRequestQuery`.
 *
 * ── Fallback contract ───────────────────────────────────────────────────────
 * Every failure path here ends in "do nothing". Doing nothing leaves the join
 * request sitting in Telegram's pending queue, where the owner approves it by
 * hand — which is exactly the behaviour of a group that has no guard bot at all.
 * So a broken call degrades to the status quo rather than locking anyone out.
 *
 * ── Probed against the live API, 2026-08-29 ─────────────────────────────────
 * The method EXISTS (an empty call answers `parameter "web_app_url" is
 * required`, not "method not found"), and grammY has no typings for it, so it
 * goes through `bot.api.raw` like `rich-message.ts` does. Exact payload notes
 * live on `JOIN_REQUEST_WEBAPP_PARAMS`.
 *
 * ── Two owner-side prerequisites ────────────────────────────────────────────
 * 1. DONE (2026-08-29): Guard Mode enabled in @BotFather — `getMe` now returns
 *    `supports_join_request_queries: true`, and the API stopped answering
 *    BOT_GUARD_NOT_SUPPORTED.
 * 2. PENDING: `getChat` on the primary group still returns no `guard_bot` — the
 *    group must be switched to approval-based joins with this bot designated as
 *    guard.
 *
 * Until (2) is done Telegram never sends `chat_join_request` with a `query_id`,
 * so this handler no-ops. Treat the guard flow as dark code: harmless, but not
 * yet load-bearing. The pre-existing nick-gate in chat-member-listener.ts stays
 * in place and MUST NOT be removed before a live join request has been observed
 * working end to end.
 *
 * Note we never answer `decline` on a bad nick — we simply do not answer, which
 * leaves the request in Telegram's pending queue (the `queue` outcome by
 * omission). Declining would force the person to submit a whole new request
 * over what is usually a typo.
 */

import { type Context } from 'grammy';
import logger from '../lib/log.ts';

type IsAllowedChat = (id: number) => boolean;

/**
 * Build the `sendChatJoinRequestWebApp` payload.
 *
 * `web_app_url` is CONFIRMED against the live API: calling the method with no
 * arguments answers `Bad Request: parameter "web_app_url" is required` (probed
 * 2026-08-29). It is a flat URL string, NOT a nested `web_app: { url }` object.
 *
 * The name of the query-id parameter is NOT yet confirmed — the API reports the
 * missing `web_app_url` first and stops, so it never got as far as complaining
 * about the id. Both plausible spellings are sent; the API ignores unknown
 * fields, so this costs nothing and one of them lands. Collapse to the real one
 * once a live join request has been observed.
 */
export function JOIN_REQUEST_WEBAPP_PARAMS(queryId: string, url: string): Record<string, unknown> {
  return {
    web_app_url: url,
    chat_join_request_query_id: queryId,
    query_id: queryId,
  };
}

/** The outcomes `answerChatJoinRequestQuery` accepts. */
export type JoinRequestResult = 'approve' | 'decline' | 'queue';

/**
 * Build the `answerChatJoinRequestQuery` payload — the call that admits someone
 * once their nick checks out.
 *
 * `result` is a STRING ENUM, not an object. Resolved by probing the live API on
 * 2026-08-29 once Guard Mode was enabled: every object form
 * (`{approve:true}`, `{type:'approve'}`, …) answers `invalid query result
 * specified`, whereas the bare string `'approve'` gets past result validation
 * and fails only on the deliberately bogus query id. Sweeping candidate strings
 * then gave exactly three members:
 *
 *   approve · decline · queue
 *
 * Note `decline`, not `reject` — BotFather's Guard Mode blurb says "approve,
 * reject, or queue", but `reject` is NOT accepted by the API. `queue` leaves the
 * request in Telegram's pending list for a human.
 *
 * The id parameter name is still undetermined and probably undeterminable this
 * way: the API returns the same "query ID is invalid" whether the id is sent
 * under either name or omitted entirely. Both spellings are sent — unknown
 * fields are ignored, so over-sending costs nothing.
 */
export function JOIN_REQUEST_ANSWER_PARAMS(
  queryId: string,
  approve: boolean,
): Record<string, unknown> {
  const result: JoinRequestResult = approve ? 'approve' : 'decline';
  return {
    chat_join_request_query_id: queryId,
    query_id: queryId,
    result,
  };
}

/** Narrow view of the raw-API surface used here. */
export interface RawJoinRequestApi {
  sendChatJoinRequestWebApp(args: Record<string, unknown>): Promise<unknown>;
  answerChatJoinRequestQuery(args: Record<string, unknown>): Promise<unknown>;
}

export interface JoinRequestListenerDeps {
  isAllowedChat: IsAllowedChat;
  /** Raw Bot API call — injected so tests never touch grammY's proxy. */
  sendChatJoinRequestWebApp: (args: Record<string, unknown>) => Promise<unknown>;
  /** Public HTTPS URL of the Mini App onboarding screen. */
  getMiniAppUrl: () => string;
}

/**
 * Factory: returns a grammY handler for `chat_join_request` updates.
 *
 * Note `allowed_updates` must include `chat_join_request`, otherwise the update
 * never arrives and the 10-second window burns silently.
 */
export function makeJoinRequestListener(deps: JoinRequestListenerDeps) {
  return async (ctx: Context): Promise<void> => {
    const update = ctx.update.chat_join_request;
    if (!update) return;

    const chatId = update.chat.id;
    const userId = update.from.id;

    if (!deps.isAllowedChat(chatId)) {
      logger.info(
        { module: 'join-request', chat_id: chatId, user_id: userId },
        'Join request for a chat outside scope — ignoring',
      );
      return;
    }

    // `query_id` only exists when the bot is configured as this chat's guard bot.
    // Without it there is nothing to answer: the request stays pending for the
    // owner, which is the correct behaviour for a not-yet-configured group.
    const queryId = (update as { query_id?: string }).query_id;
    if (!queryId) {
      logger.info(
        { module: 'join-request', chat_id: chatId, user_id: userId },
        'Join request without query_id — bot is not the guard bot for this chat; leaving pending',
      );
      return;
    }

    const url = deps.getMiniAppUrl();
    if (!url) {
      logger.warn(
        { module: 'join-request', chat_id: chatId, user_id: userId },
        'Mini App URL not configured — cannot show nick prompt; leaving request pending',
      );
      return;
    }

    try {
      await deps.sendChatJoinRequestWebApp(JOIN_REQUEST_WEBAPP_PARAMS(queryId, url));
      logger.info(
        { module: 'join-request', chat_id: chatId, user_id: userId },
        'Showed nick Mini App to join requester',
      );
    } catch (err) {
      // Log the API's own words — this is the signal that tells you whether the
      // parameter names above are wrong versus the chat not being configured.
      logger.warn(
        { module: 'join-request', chat_id: chatId, user_id: userId, err },
        'sendChatJoinRequestWebApp failed — leaving request pending for manual approval',
      );
    }
  };
}
