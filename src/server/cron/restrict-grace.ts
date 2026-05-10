/**
 * restrict-grace.ts — Daily cron: restrict unlinked users after 30-day grace period.
 *
 * Croner '0 6 * * *' (06:00 daily) timezone Europe/Kyiv.
 *
 * Per tick, for each chat in TELEGRAM_ALLOWED_CHAT_IDS:
 * 1. Fetch getChatAdministrators — collect admin user IDs (cache for this tick).
 *    If that fails (bot lost admin) → log warning, skip whole chat.
 * 2. SELECT users WHERE riot_name IS NULL AND restricted_at IS NULL AND joined_at <= now - 30d.
 *    (riot_name IS NOT NULL means the user has attempted to link — treat as engaged, skip.)
 * 3. Skip admins, the bot itself.
 * 4. For each remaining user: call restrictChatMember with all permissions FALSE.
 *    On success → UPDATE restricted_at = now.
 *    On API error → log warning, do NOT mark restricted_at, continue.
 */

import { Cron } from 'croner';
import { isNull, lte, and, eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export const READONLY_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} as const;

export const FULL_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
} as const;

const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

export interface RestrictGraceDeps {
  db: AnyDb;
  /** Returns the set of allowed Telegram chat IDs. */
  getAllowedChatIds: () => Set<number>;
  /** Bot's own Telegram user ID — never restrict the bot itself. Evaluated lazily each tick. */
  getBotId: () => number;
  /** Telegram Bot API: restrict a chat member. */
  restrictChatMember: (
    chatId: number,
    userId: number,
    permissions: typeof READONLY_PERMISSIONS,
  ) => Promise<void>;
  /** Telegram Bot API: get administrators of a chat. */
  getChatAdministrators: (chatId: number) => Promise<Array<{ user: { id: number } }>>;
  /** Injectable now timestamp in ms, defaults to Date.now(). */
  getNowMs?: () => number;
}

export async function runRestrictGraceTick(deps: RestrictGraceDeps): Promise<void> {
  const { db, getAllowedChatIds, getBotId, restrictChatMember, getChatAdministrators } = deps;
  const botId = getBotId();
  const getNowMs = deps.getNowMs ?? (() => Date.now());

  const nowMs = getNowMs();
  const graceCutoffMs = nowMs - GRACE_PERIOD_MS;

  // Select users who have never attempted to link (riot_name IS NULL),
  // are not yet restricted, and are past the 30-day grace period.
  // Users with riot_name set (pending or fully linked) are treated as engaged — skip them.
  const unlinkedUsers: Array<{ telegram_id: number }> = await db
    .select({ telegram_id: users.telegram_id })
    .from(users)
    .where(
      and(
        isNull(users.riot_name),
        isNull(users.restricted_at),
        lte(users.joined_at, graceCutoffMs),
      ),
    );

  if (unlinkedUsers.length === 0) {
    logger.info({ module: 'restrict-grace' }, 'No eligible users to restrict this tick');
    return;
  }

  const chatIds = getAllowedChatIds();
  // Track which users were successfully restricted across all chats
  const successfullyRestricted = new Set<number>();

  for (const chatId of chatIds) {
    // Fetch admins — if this fails, bot lost admin in this chat → skip
    let adminIds: Set<number>;
    try {
      const admins = await getChatAdministrators(chatId);
      adminIds = new Set(admins.map((a) => a.user.id));
    } catch (err) {
      logger.warn({ module: 'restrict-grace', chat_id: chatId, err }, 'getChatAdministrators failed — skipping chat');
      continue;
    }

    for (const row of unlinkedUsers) {
      const userId = row.telegram_id;

      // Skip admins and the bot itself
      if (adminIds.has(userId) || userId === botId) {
        continue;
      }

      try {
        await restrictChatMember(chatId, userId, READONLY_PERMISSIONS);
        successfullyRestricted.add(userId);
        logger.info(
          { module: 'restrict-grace', chat_id: chatId, telegram_id: userId },
          'User restricted (read-only)',
        );
      } catch (err) {
        logger.warn(
          { module: 'restrict-grace', chat_id: chatId, telegram_id: userId, err },
          'restrictChatMember failed — not marking restricted_at',
        );
      }
    }
  }

  // Update restricted_at for all users successfully restricted in at least one chat
  for (const userId of successfullyRestricted) {
    const restrictedAt = getNowMs();
    await db
      .update(users)
      .set({ restricted_at: restrictedAt })
      .where(eq(users.telegram_id, userId));
  }
}

export function startRestrictGraceLoop(deps: RestrictGraceDeps): () => void {
  const cronJob = new Cron(
    '0 6 * * *',
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runRestrictGraceTick(deps);
    },
  );

  logger.info({ module: 'restrict-grace', cron: '0 6 * * *', tz: 'Europe/Kyiv' }, 'Restrict-grace loop started');

  return function stopRestrictGraceLoop() {
    cronJob.stop();
    logger.info({ module: 'restrict-grace' }, 'Restrict-grace loop stopped');
  };
}
