/**
 * chat-member-listener.ts — grammY handler that tracks group membership via
 * chat_member updates.
 *
 * Fires when a user joins, leaves, is kicked, promoted, demoted, or restricted.
 *
 * - STATUSES_IN: UPSERTs a skeleton user row (preserves riot_puuid + last_message_at).
 * - STATUSES_OUT: Hard-deletes the user row.
 * - Bot users are always ignored.
 * - Scope-guarded by isAllowedChat (same pattern as listener.ts).
 *
 * `restricted` status needs special handling: is_member=true means the user is
 * still in the group (IN), is_member=false means they were restricted-out (OUT).
 */

import { type Context } from 'grammy';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import logger from '../lib/log.ts';
import { users } from '../db/schema/users.ts';

// Accept any Drizzle SQLite-compatible db (bun-sqlite or better-sqlite3 in tests)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any> | LibSQLDatabase<any> | any;

type IsAllowedChat = (id: number) => boolean;

export interface ChatMemberListenerDeps {
  db: AnyDb;
  isAllowedChat: IsAllowedChat;
}

const STATUSES_IN = new Set(['member', 'administrator', 'creator', 'restricted']);
const STATUSES_OUT = new Set(['left', 'kicked']);

/**
 * Factory: returns a grammY handler that tracks membership via chat_member updates.
 *
 * In production, pass the real `db` from `./db/client.ts` and `isAllowedChat`
 * from `../lib/scope.ts`. In tests, inject an in-memory better-sqlite3 db and
 * a stub `isAllowedChat`.
 */
export function makeChatMemberListener(deps: ChatMemberListenerDeps) {
  return async (ctx: Context): Promise<void> => {
    const update = ctx.update.chat_member;
    if (!update) return;

    const chat = update.chat;
    const u = update.new_chat_member.user;
    const status = update.new_chat_member.status;

    // Skip bots
    if (u.is_bot) return;

    // Scope guard — only handle allowed chats
    if (!deps.isAllowedChat(chat.id)) return;

    // Determine if the user is now in the group or out of it.
    // For 'restricted', check the is_member flag explicitly.
    let inGroup: boolean;
    if (status === 'restricted') {
      inGroup = (update.new_chat_member as { is_member?: boolean }).is_member === true;
    } else if (STATUSES_IN.has(status)) {
      inGroup = true;
    } else if (STATUSES_OUT.has(status)) {
      inGroup = false;
    } else {
      // Unknown status — skip
      logger.warn(
        { event: 'chat_member_unknown_status', status, user_id: u.id, chat_id: chat.id },
        'Unrecognised chat_member status — skipping',
      );
      return;
    }

    try {
      if (inGroup) {
        // UPSERT skeleton row — preserves riot_puuid + last_message_at if already there
        await deps.db
          .insert(users)
          .values({
            telegram_id: u.id,
            telegram_username: u.username ?? null,
          })
          .onConflictDoUpdate({
            target: users.telegram_id,
            set: { telegram_username: sql`excluded.telegram_username` },
          });

        logger.debug(
          { event: 'chat_member_joined', user_id: u.id, chat_id: chat.id, status },
          'User joined — upserted row',
        );
      } else {
        // Hard delete — match_records + detected_events are puuid-keyed, no FK fan-out
        await deps.db.delete(users).where(eq(users.telegram_id, u.id));

        logger.debug(
          { event: 'chat_member_left', user_id: u.id, chat_id: chat.id, status },
          'User left/kicked — deleted row',
        );
      }
    } catch (err) {
      logger.error(
        { event: 'chat_member_error', user_id: u.id, chat_id: chat.id, status, err },
        'Failed to handle chat_member update',
      );
    }
  };
}
