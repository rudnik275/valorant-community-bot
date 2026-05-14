/**
 * safe-telegram.ts — Gated wrappers around Telegram Bot API calls.
 *
 * ALL outbound Telegram API calls in this codebase MUST go through these
 * wrappers instead of using `bot.api.*` directly. This is the defence-in-depth
 * layer that ensures no message/action is sent to an unauthorized chat even if
 * the scope-guard middleware is somehow bypassed.
 *
 * See src/server/bot/README.md for details.
 */

import type { Api } from 'grammy';
import logger from './log.ts';
import { isAllowedChat } from './scope.ts';

export class UnauthorizedChatError extends Error {
  constructor(chatId: number) {
    super(`Chat ${chatId} is not in the allowed chat list`);
    this.name = 'UnauthorizedChatError';
  }
}

function assertAllowed(chatId: number): void {
  if (!isAllowedChat(chatId)) {
    logger.warn({ event: 'safe_telegram_block', chat_id: chatId }, 'Blocked outbound API call to unauthorized chat');
    throw new UnauthorizedChatError(chatId);
  }
}

export async function safeSendMessage(
  api: Api,
  chatId: number,
  text: string,
  opts?: Parameters<Api['sendMessage']>[2],
): ReturnType<Api['sendMessage']> {
  assertAllowed(chatId);
  return api.sendMessage(chatId, text, opts);
}

