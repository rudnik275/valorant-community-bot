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
 *
 * Nick-gate (2026-06-12): when a user joins fresh (status === 'member') and has
 * NOT entered a nick (riot_name IS NULL, not yet restricted, not an admin), the
 * bot restricts them to read-only immediately. This is the "немедленно" half of
 * the policy — the daily restrict-grace cron is the safety-net sweep. The
 * restriction is lifted by onboard.ts the moment the user enters a nick. Only
 * wired when restrictChatMember + getChatAdministrators deps are provided; absent
 * them (e.g. unit tests of pure membership tracking), on-join restriction is a
 * no-op.
 */

import { type Context } from 'grammy';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import logger from '../lib/log.ts';
import { users } from '../db/schema/users.ts';
import { READONLY_PERMISSIONS } from '../cron/restrict-grace.ts';

// Accept any Drizzle SQLite-compatible db (bun-sqlite or better-sqlite3 in tests)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BetterSQLite3Database<any> | LibSQLDatabase<any> | any;

type IsAllowedChat = (id: number) => boolean;

export interface ChatMemberListenerDeps {
  db: AnyDb;
  isAllowedChat: IsAllowedChat;
  /**
   * Telegram Bot API: restrict a chat member. Optional — when absent, on-join
   * read-only restriction is skipped (membership tracking still works).
   */
  restrictChatMember?: (
    chatId: number,
    userId: number,
    permissions: typeof READONLY_PERMISSIONS,
  ) => Promise<void>;
  /**
   * Telegram Bot API: get chat administrators. Required alongside
   * restrictChatMember to skip restricting admins on join.
   */
  getChatAdministrators?: (chatId: number) => Promise<Array<{ user: { id: number } }>>;
  /** Injectable now timestamp in ms, defaults to Date.now(). */
  getNowMs?: () => number;
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
            // COALESCE: preserve existing username if the new value is null
            // (Telegram omits username when privacy is on or user has none)
            set: { telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})` },
          });

        logger.debug(
          { event: 'chat_member_joined', user_id: u.id, chat_id: chat.id, status },
          'User joined — upserted row',
        );

        // Nick-gate: a fresh join (status === 'member') with no nick → restrict
        // to read-only immediately. We only act on 'member' so the 'restricted'
        // echo from our own restrict call (and admin/creator joins) never loops.
        if (status === 'member' && deps.restrictChatMember && deps.getChatAdministrators) {
          await restrictOnJoinIfNoNick(deps, chat.id, u.id);
        }
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

/**
 * Restrict a freshly-joined member to read-only if they have not entered a nick.
 * No-op if the user already entered a nick (riot_name set), is already restricted,
 * or is a chat admin. Failures are logged and swallowed — never crash the handler.
 * Caller guarantees restrictChatMember + getChatAdministrators are present.
 */
async function restrictOnJoinIfNoNick(
  deps: ChatMemberListenerDeps,
  chatId: number,
  userId: number,
): Promise<void> {
  const restrictChatMember = deps.restrictChatMember!;
  const getChatAdministrators = deps.getChatAdministrators!;
  const getNowMs = deps.getNowMs ?? (() => Date.now());

  // Read back the row: has this user entered a nick, or are they already restricted?
  const [row]: Array<{ riot_name: string | null; restricted_at: number | null }> = await deps.db
    .select({ riot_name: users.riot_name, restricted_at: users.restricted_at })
    .from(users)
    .where(eq(users.telegram_id, userId))
    .limit(1);

  // Engaged (entered a nick) or already restricted → nothing to do.
  if (!row || row.riot_name !== null || row.restricted_at !== null) return;

  // Skip admins. If we can't fetch the admin list, skip restriction this time
  // (the daily cron is the safety net) rather than risk muting an admin.
  let adminIds: Set<number>;
  try {
    const admins = await getChatAdministrators(chatId);
    adminIds = new Set(admins.map((a) => a.user.id));
  } catch (err) {
    logger.warn(
      { event: 'restrict_on_join_admins_failed', user_id: userId, chat_id: chatId, err },
      'getChatAdministrators failed — skipping on-join restrict (cron will sweep)',
    );
    return;
  }
  if (adminIds.has(userId)) return;

  try {
    await restrictChatMember(chatId, userId, READONLY_PERMISSIONS);
    await deps.db
      .update(users)
      .set({ restricted_at: getNowMs() })
      .where(eq(users.telegram_id, userId));
    logger.info(
      { event: 'restrict_on_join', user_id: userId, chat_id: chatId },
      'New member without nick restricted (read-only) on join',
    );
  } catch (err) {
    logger.warn(
      { event: 'restrict_on_join_failed', user_id: userId, chat_id: chatId, err },
      'restrictChatMember failed on join — not marking restricted_at',
    );
  }
}
