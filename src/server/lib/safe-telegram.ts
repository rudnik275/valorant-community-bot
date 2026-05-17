/**
 * safe-telegram.ts — Thin re-export shim.
 *
 * The actual implementation has moved to `telegram-send.ts` which owns the
 * full outbound-Telegram concern: allowlist guard + retry/backoff + named
 * exempt path for owner-DM / primary-chat sends.
 *
 * This file is kept for backward-compatible imports only — all new code should
 * import directly from `./telegram-send.ts`.
 */

export { UnauthorizedChatError, safeSendMessage } from './telegram-send.ts';
