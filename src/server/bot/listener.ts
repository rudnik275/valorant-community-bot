/**
 * listener.ts — grammY handler that tracks the last time a user was active
 * in the group.
 *
 * Fires on: message only. Edited messages and reactions are intentionally
 * ignored so that only fresh posts move a user up the Mini App list.
 * UPSERTs a skeleton user row with last_message_at = now().
 * joined_at is preserved on conflict (not included in the SET clause).
 * Uses MAX(COALESCE(...)) so out-of-order event delivery never goes backwards.
 */

import { type Context } from 'grammy';
import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import logger from '../lib/log.ts';
import { users } from '../db/schema/users.ts';

// Accept any Drizzle SQLite-compatible db (bun-sqlite or better-sqlite3 in tests)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any> | LibSQLDatabase<any> | any;

type IsAllowedChat = (id: number) => boolean;

export interface LastMessageHandlerDeps {
  db: AnyDb;
  isAllowedChat: IsAllowedChat;
}

/**
 * Determine which update kind this context represents.
 * Only fresh messages count — edited messages and reactions are ignored.
 */
function updateKind(ctx: Context): 'message' | null {
  if (ctx.update.message) return 'message';
  return null;
}

/**
 * Factory: returns a grammY handler that UPSERTs users on every relevant event.
 *
 * In production, pass the real `db` from `./db/client.ts` and `isAllowedChat`
 * from `../lib/scope.ts`. In tests, inject an in-memory better-sqlite3 db and
 * a stub `isAllowedChat`.
 */
export function makeLastMessageHandler(deps: LastMessageHandlerDeps) {
  return async (ctx: Context): Promise<void> => {
    const from = ctx.from;
    const chat = ctx.chat;

    // Skip if no user info
    if (!from) return;

    // Skip bots (including this bot itself, via ctx.me.id)
    if (from.is_bot) return;
    if (from.id === ctx.me.id) return;

    // Skip private chats — this listener is about group activity
    if (!chat || chat.type === 'private') return;

    // Defence-in-depth: check allowlist even though scope-guard already filtered
    if (!deps.isAllowedChat(chat.id)) return;

    const kind = updateKind(ctx);
    if (!kind) return;

    const now = Date.now();

    try {
      await deps.db
        .insert(users)
        .values({
          telegram_id: from.id,
          telegram_username: from.username ?? null,
          last_message_at: now,
        })
        .onConflictDoUpdate({
          target: users.telegram_id,
          set: {
            // COALESCE: preserve existing username if the new value is null
            // (Telegram omits username when privacy is on or user has none)
            telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})`,
            // MAX ensures we never go backwards if events arrive out of order
            last_message_at: sql`MAX(COALESCE(${users.last_message_at}, 0), excluded.last_message_at)`,
          },
        });

      logger.debug(
        { event: 'last_message_at_updated', user_id: from.id, chat_id: chat.id, kind },
        'User activity recorded',
      );
    } catch (err) {
      logger.error(
        { event: 'last_message_at_error', user_id: from.id, chat_id: chat.id, err },
        'Failed to upsert user last_message_at',
      );
    }
  };
}
