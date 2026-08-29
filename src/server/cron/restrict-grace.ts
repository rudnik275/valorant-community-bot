/**
 * restrict-grace.ts — Daily cron: restrict any member who hasn't entered a Riot nick.
 *
 * Policy (2026-06-12): no grace period. Anyone may JOIN the group, but to WRITE
 * they must have entered a nick (riot_name set). The read-only restriction exists
 * precisely to coerce nick entry. The 30-day onboard grace (issue #118) is removed.
 *
 * The criterion is `riot_name IS NULL` — the user never entered a nick at all.
 * A user who entered a nick whose account is inactive/stale (riot_name set, no
 * riot_puuid) still counts as engaged and is NEVER restricted — they stay a full
 * participant. This is the daily safety-net sweep; new joiners are restricted
 * immediately on join by chat-member-listener.ts.
 *
 * Croner '0 6 * * *' (06:00 daily) timezone Europe/Kyiv.
 *
 * Per tick:
 * 1. Resolve administrators for every chat in TELEGRAM_ALLOWED_CHAT_IDS. A chat
 *    whose admin list can't be fetched (bot lost admin) is skipped entirely.
 * 2. SELECT users WHERE riot_name IS NULL AND restricted_at IS NULL.
 * 3. Skip the bot, and skip any chat where the user is an administrator.
 * 4. Hand each remaining user to `gateMember`, which restricts, records
 *    restricted_at and sends the one explanation. This module owns WHO gets
 *    gated; it deliberately owns none of WHAT gating means.
 */

import { Cron } from 'croner';
import { isNull, and } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import logger from '../lib/log.ts';
import { gateMember, type MemberGateDeps } from '../gate/member-gate.ts';

/**
 * Everything `gateMember` needs (db, restrictChatMember, notify, …) plus what
 * only the sweep needs. Extending rather than restating keeps the two from
 * drifting when the gate grows a dependency.
 */
export interface RestrictGraceDeps extends MemberGateDeps {
  /** Returns the set of allowed Telegram chat IDs. */
  getAllowedChatIds: () => Set<number>;
  /** Bot's own Telegram user ID — never restrict the bot itself. Evaluated lazily each tick. */
  getBotId: () => number;
  /** Telegram Bot API: get administrators of a chat. */
  getChatAdministrators: (chatId: number) => Promise<Array<{ user: { id: number } }>>;
}

export async function runRestrictGraceTick(deps: RestrictGraceDeps): Promise<void> {
  const { db, getAllowedChatIds, getBotId, getChatAdministrators } = deps;
  const botId = getBotId();

  // Select users who never entered a nick (riot_name IS NULL) and are not yet
  // restricted. No grace window — entering a nick is the only way out of read-only.
  // Users with riot_name set (pending or fully linked) are treated as engaged — skip them.
  const unlinkedUsers: Array<{ telegram_id: number }> = await db
    .select({ telegram_id: users.telegram_id })
    .from(users)
    .where(
      and(
        isNull(users.riot_name),
        isNull(users.restricted_at),
      ),
    );

  if (unlinkedUsers.length === 0) {
    logger.info({ module: 'restrict-grace' }, 'No eligible users to restrict this tick');
    return;
  }

  // Resolve admins per chat FIRST, then gate per user. Iterating users on the
  // outside is what lets a user be gated across every chat in one call — and
  // therefore receive exactly one notice instead of one per chat.
  const adminsByChat = new Map<number, Set<number>>();
  for (const chatId of getAllowedChatIds()) {
    try {
      const admins = await getChatAdministrators(chatId);
      adminsByChat.set(chatId, new Set(admins.map((a) => a.user.id)));
    } catch (err) {
      // Bot lost admin here (or the API blipped) — skip the chat rather than
      // risk gating an administrator.
      logger.warn({ module: 'restrict-grace', chat_id: chatId, err }, 'getChatAdministrators failed — skipping chat');
    }
  }

  for (const row of unlinkedUsers) {
    const userId = row.telegram_id;
    if (userId === botId) continue;

    const chatIds = [...adminsByChat.entries()]
      .filter(([, adminIds]) => !adminIds.has(userId))
      .map(([chatId]) => chatId);
    if (chatIds.length === 0) continue;

    await gateMember(deps, {
      chatIds,
      userId,
      reason: { kind: 'no_nick' },
      source: 'restrict-grace',
    });
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
