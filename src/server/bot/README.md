# bot/

grammY bot handlers — middleware and filters for the Valorant community Telegram bot.

Implemented in issue #5 (chat-scope-guard).

## Chat scope guard

`scope-guard.ts` is the first middleware registered on the bot. It enforces the
`TELEGRAM_ALLOWED_CHAT_IDS` allowlist at the update-processing layer:

- Updates from non-allowlisted chats are silently dropped (no `next()` call).
- Private chats are always passed through (users can DM the bot for onboarding).
- `my_chat_member` updates where the bot itself is added to an unauthorized chat
  trigger an automatic `leaveChat` call before dropping the update.

## Privacy mode

By default, Telegram bots in **privacy mode** only receive messages that are direct replies to the bot or that mention the bot by username. To receive **all** group messages (required for the `last_message_at` listener to fire on every message, reaction, and edit), you must disable privacy mode in BotFather:

1. Open [@BotFather](https://t.me/BotFather) → `/mybots` → select your bot.
2. Go to **Bot Settings** → **Group Privacy** → **Turn off**.

Without this step, Telegram will not deliver regular group messages to the bot via `getUpdates`, and `users.last_message_at` will only update when users interact with the bot directly.

## Rule: always use safe-telegram wrappers

All outbound Telegram API calls **must** go through the wrappers in
`src/server/lib/safe-telegram.ts` (`safeSendMessage`, `safePromote`,
`safeSetCustomTitle`). Never call `bot.api.*` directly in handlers or other
modules (publisher, onboarding, riot-id-auto-tracker, weekly-digest, etc.).

**Why:** The scope-guard middleware is a first line of defence, but it only
operates on *incoming* updates. The safe-telegram wrappers provide a second,
independent check on every *outgoing* API call. This defence-in-depth ensures
that even if a handler is invoked via a code path that bypasses the middleware
(e.g. a scheduled job, a webhook with an unusual update shape, or future code
that forgets to register the guard), no message or admin action will be sent to
an unauthorized chat.

**Lint/review rule:** PRs that introduce direct `bot.api.*` / `ctx.api.*`
calls in application code (outside of `scope-guard.ts` itself) must be
rejected and rewritten to use the wrappers.
