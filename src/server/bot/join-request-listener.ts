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
 * ── Two owner-side prerequisites, NEITHER of them satisfied yet ──────────────
 * 1. `getMe` currently returns `supports_join_request_queries: false` — join
 *    request queries are off for this bot and must be enabled in @BotFather.
 * 2. `getChat` on the primary group returns no `guard_bot` field — the group is
 *    not configured to use one, and must be switched to approval-based joins
 *    with this bot designated as guard.
 *
 * Until both are done Telegram never sends `chat_join_request` with a
 * `query_id`, so this handler no-ops. Treat the guard flow as dark code:
 * harmless, but not yet load-bearing. The pre-existing nick-gate in
 * chat-member-listener.ts stays in place and MUST NOT be removed before a live
 * join request has been observed working end to end.
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

/**
 * Build the `answerChatJoinRequestQuery` payload — the call that actually admits
 * someone once their nick checks out.
 *
 * STILL UNRESOLVED. The method exists, but an empty call answers `Bad Request:
 * invalid query result specified` (probed 2026-08-29), which says it wants a
 * structured "query result" rather than a plain approve boolean — and the shape
 * of that result could not be determined: the official reference page truncates
 * before this method, and a second probe round was cut short when the 1Password
 * session locked.
 *
 * Several spellings are sent at once because the Bot API ignores unknown fields,
 * so the cost of over-sending is zero while the cost of guessing wrong and
 * sending nothing is a friend stuck outside the group. If none of them is right
 * the call fails, the request stays pending, and the owner approves by hand —
 * the documented fallback. Resolve this before removing the old nick-gate.
 */
export function JOIN_REQUEST_ANSWER_PARAMS(
  queryId: string,
  approve: boolean,
): Record<string, unknown> {
  return {
    chat_join_request_query_id: queryId,
    query_id: queryId,
    approve,
    result: { approve },
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
