/**
 * ephemeral-message.ts — thin typed wrapper over ephemeral messages (Bot API
 * 10.2, reshaped in 10.3), which grammY has no typings for yet.
 *
 * An ephemeral message is posted INTO a group but rendered only for one
 * recipient. For a ~30-person chat that is the difference between "tell one
 * person something" and "make 29 people read it".
 *
 * Shape targeted here is the 10.3 one: 10.2's flat `receiver_user_id` /
 * `callback_query_id` parameters were replaced by a single
 * `ephemeral_message_parameters` object, so writing to the older shape would be
 * writing to an already-superseded API.
 *
 * As with `rich-message.ts`, the call goes through `bot.api.raw` — a Proxy that
 * forwards unknown method names straight to the Bot API — behind a narrow local
 * cast mirroring the documented parameter shape.
 *
 * ── Probed against the live API, 2026-08-29 ─────────────────────────────────
 * The field name and shape below are CONFIRMED. Sending
 * `ephemeral_message_parameters: "not-an-object"` answers `Bad Request: can't
 * parse EphemeralMessageParameters JSON object` (so the API knows the field),
 * while `{ receiver_user_id: 1 }` parses cleanly and the call then fails only on
 * the deliberately bogus chat id.
 *
 * What is still UNPROVEN is delivery semantics: whether a receiver who did not
 * just interact with the bot actually sees the message. That needs a real send
 * to a real chat. `notifyUserQuietly` therefore still never assumes success —
 * see its fallback chain, and do not "simplify" it away until a delivery has
 * been observed by eye.
 */

import type { Api } from 'grammy';
import logger from './log.ts';

/** Narrow view of the raw-API surface used for an ephemeral `sendMessage`. */
export interface RawSendEphemeralMessage {
  sendMessage(args: {
    chat_id: number;
    text: string;
    parse_mode: 'HTML';
    ephemeral_message_parameters: { receiver_user_id: number };
  }): Promise<{ message_id: number }>;
}

/**
 * Post an ephemeral HTML message into `chatId` visible only to `userId`.
 * Throws on any API error — callers decide the fallback.
 */
export async function sendEphemeralHtml(
  api: Api,
  chatId: number,
  userId: number,
  html: string,
): Promise<{ message_id: number }> {
  const raw = api.raw as unknown as RawSendEphemeralMessage;
  const res = await raw.sendMessage({
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    ephemeral_message_parameters: { receiver_user_id: userId },
  });
  return { message_id: res.message_id };
}

/** How a quiet notification actually reached (or failed to reach) the user. */
export type QuietNotifyOutcome = 'ephemeral' | 'dm' | 'skipped';

export interface QuietNotifyDeps {
  /** Ephemeral send — injectable for tests. */
  sendEphemeral: (chatId: number, userId: number, html: string) => Promise<unknown>;
  /** Direct-message send — injectable for tests. */
  sendDirect: (userId: number, html: string) => Promise<unknown>;
}

/**
 * Tell one user something without making it everyone's problem.
 *
 * Order matters and is deliberate:
 *   1. ephemeral in the group — always deliverable, since the user is in the
 *      chat, and invisible to the other members;
 *   2. direct message — deliverable only if the user has ever started the bot,
 *      which most group members never have;
 *   3. give up quietly.
 *
 * The DM fallback exists because step 1 is unverified (see module header): if
 * ephemeral turns out to be callback-only, this degrades to today's reachability
 * instead of silently dropping every notification. Never throws — a notification
 * failing must not abort the caller's real work (restricting a user, resolving a
 * join request).
 */
export async function notifyUserQuietly(
  deps: QuietNotifyDeps,
  args: { chatId: number; userId: number; html: string; reason: string },
): Promise<QuietNotifyOutcome> {
  const { chatId, userId, html, reason } = args;

  try {
    await deps.sendEphemeral(chatId, userId, html);
    logger.info(
      { module: 'notify', delivery: 'ephemeral', user_id: userId, chat_id: chatId, reason },
      'Quiet notification delivered as ephemeral',
    );
    return 'ephemeral';
  } catch (err) {
    logger.warn(
      { module: 'notify', delivery: 'ephemeral', user_id: userId, chat_id: chatId, reason, err },
      'Ephemeral send failed — falling back to DM',
    );
  }

  try {
    await deps.sendDirect(userId, html);
    logger.info(
      { module: 'notify', delivery: 'dm', user_id: userId, reason },
      'Quiet notification delivered as DM',
    );
    return 'dm';
  } catch (err) {
    // Expected for users who never opened a private chat with the bot.
    logger.warn(
      { module: 'notify', delivery: 'dm', user_id: userId, reason, err },
      'DM fallback failed — user not notified',
    );
    return 'skipped';
  }
}
