/**
 * rich-message.ts — thin typed wrapper over the Bot API `sendRichMessage`
 * method (added in Bot API 10.1, 2026-06-11; media in 10.2), which grammY has
 * no typings for yet (#309, spike #306).
 *
 * `bot.api.raw` is a Proxy that forwards unknown method names straight to the
 * Bot API, so we call `sendRichMessage` through a narrow local cast that mirrors
 * the documented parameter shape:
 *
 *   sendRichMessage(chat_id, rich_message: InputRichMessage, ...optional)
 *
 * `InputRichMessage` requires exactly one of `html` | `markdown` | `blocks`; we
 * only ever use `html`. The promo cover image is NOT embedded via the rich
 * `media` field — see PR #309: the Rich HTML dialect only accepts HTTP/HTTPS
 * media URLs in the `html` field, and embedding a locally-generated PNG buffer
 * requires the `tg://photo?id=` + `attach://` multipart path through this
 * untyped raw proxy, which is fragile. The existing best-effort photo-reply
 * flow is kept instead, so this wrapper stays `html`-only.
 */

import type { Api } from 'grammy';

/** The `InputRichMessage` value — html variant only (see module header). */
export interface InputRichMessageHtml {
  html: string;
}

/** Narrow view of the raw-API surface we use for `sendRichMessage`. */
export interface RawSendRichMessage {
  sendRichMessage(args: {
    chat_id: number;
    rich_message: InputRichMessageHtml;
  }): Promise<{ message_id: number }>;
}

/**
 * Send a Rich Message (HTML) to `chatId` via grammY's raw-API proxy and return
 * the posted message id. Throws on any API error — callers that need a legacy
 * fallback (the weekly publish tick) catch and fall back to `sendMessage`.
 *
 * No allowlist guard here: the sole production caller is the weekly digest
 * publish path, whose destination is `TELEGRAM_PRIMARY_CHAT_ID` (the already
 * authorised group) — identical risk-model to the digest text's exempt send.
 */
export async function sendRichMessageHtml(
  api: Api,
  chatId: number,
  html: string,
): Promise<{ message_id: number }> {
  const raw = api.raw as unknown as RawSendRichMessage;
  const res = await raw.sendRichMessage({
    chat_id: chatId,
    rich_message: { html },
  });
  return { message_id: res.message_id };
}
