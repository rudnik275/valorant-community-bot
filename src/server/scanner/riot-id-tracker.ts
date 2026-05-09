/**
 * riot-id-tracker.ts — Daily PUUID → name+tag refresh + Telegram custom_title update.
 *
 * Runs once a day at 06:00 Kyiv time (Europe/Kyiv).
 * For each user with riot_puuid:
 *   - Calls getAccountByPuuid to look up current name+tag.
 *   - If changed: updates users table and calls safeSetCustomTitle in every allowed chat.
 *   - On 404: records riot_lookup_failed_since (first-failure timestamp, never overwritten).
 *   - On 429 / 5xx: logs warn, skips the user (retried on next tick).
 *
 * Per-chat Telegram errors (not_admin, user_not_found, 429) are logged and skipped
 * without aborting the tick.
 */

import { Cron } from 'croner';
import { isNotNull, eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import { HenrikNotFoundError, HenrikRateLimitError, HenrikUpstreamError } from '../lib/henrik.ts';
import { formatRiotTitle } from '../lib/format-title.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface RiotIdTrackerDeps {
  db: AnyDb;
  getAccountByPuuid: (puuid: string) => Promise<{ name: string; tag: string; puuid: string; region: string }>;
  setCustomTitleInChat: (chatId: number, telegramId: number, title: string) => Promise<void>;
  getAllowedChatIds: () => Set<number>;
  /** Injectable for testing — defaults to real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP_MS = 1500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UserRow {
  telegram_id: number;
  riot_puuid: string;
  riot_name: string | null;
  riot_tag: string | null;
  riot_lookup_failed_since: number | null;
}

export function makeRiotIdTracker(deps: RiotIdTrackerDeps) {
  const { db, getAccountByPuuid, setCustomTitleInChat, getAllowedChatIds } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  async function refreshUser(user: UserRow): Promise<{ changed: boolean; chatsUpdated: number }> {
    const { telegram_id, riot_puuid, riot_name, riot_tag, riot_lookup_failed_since } = user;

    let account: { name: string; tag: string };
    try {
      account = await getAccountByPuuid(riot_puuid);
    } catch (err) {
      if (err instanceof HenrikNotFoundError) {
        logger.warn(
          { module: 'riot-id-tracker', telegramId: telegram_id, riot_puuid },
          'PUUID not found in Henrik (Riot account deleted or renamed?) — setting riot_lookup_failed_since if not set',
        );
        // Only set failed_since on the first 404 — preserve the original timestamp
        if (riot_lookup_failed_since === null || riot_lookup_failed_since === undefined) {
          await db
            .update(users)
            .set({ riot_lookup_failed_since: Date.now() })
            .where(eq(users.telegram_id, telegram_id));
        }
        return { changed: false, chatsUpdated: 0 };
      }

      if (err instanceof HenrikRateLimitError) {
        logger.warn(
          { module: 'riot-id-tracker', telegramId: telegram_id, retryAfter: err.retryAfter },
          'Henrik rate limited — will retry on next tick',
        );
        return { changed: false, chatsUpdated: 0 };
      }

      if (err instanceof HenrikUpstreamError) {
        logger.warn(
          { module: 'riot-id-tracker', telegramId: telegram_id, status: err.status },
          'Henrik upstream error — skipping user, will retry on next tick',
        );
        return { changed: false, chatsUpdated: 0 };
      }

      // Unexpected error — log and skip
      logger.warn(
        { module: 'riot-id-tracker', telegramId: telegram_id, err },
        'Unexpected error from Henrik — skipping user',
      );
      return { changed: false, chatsUpdated: 0 };
    }

    const { name, tag } = account;
    const nameUnchanged = name === riot_name && tag === riot_tag;

    if (nameUnchanged) {
      // No change — but if there was a previous failure, clear it (account recovered)
      if (riot_lookup_failed_since !== null && riot_lookup_failed_since !== undefined) {
        await db
          .update(users)
          .set({ riot_lookup_failed_since: null })
          .where(eq(users.telegram_id, telegram_id));
      }
      return { changed: false, chatsUpdated: 0 };
    }

    // Name changed — update DB
    const oldRiotId = `${riot_name ?? '?'}#${riot_tag ?? '?'}`;
    const newRiotId = `${name}#${tag}`;

    await db
      .update(users)
      .set({ riot_name: name, riot_tag: tag, riot_lookup_failed_since: null })
      .where(eq(users.telegram_id, telegram_id));

    // Update Telegram custom_title in every allowed chat
    const chatIds = getAllowedChatIds();
    const title = formatRiotTitle(name, tag);
    let chatsUpdated = 0;

    for (const chatId of chatIds) {
      try {
        await setCustomTitleInChat(chatId, telegram_id, title);
        chatsUpdated++;
      } catch (chatErr) {
        const msg = chatErr instanceof Error ? chatErr.message : String(chatErr);
        if (
          msg.includes('not enough rights') ||
          msg.includes('bot is not admin') ||
          msg.includes('CHAT_ADMIN_REQUIRED')
        ) {
          logger.warn(
            { module: 'riot-id-tracker', telegramId: telegram_id, chatId, reason: 'not_admin' },
            'Bot is not admin in chat — skipping',
          );
        } else if (msg.includes('user_not_found') || msg.includes('USER_NOT_FOUND')) {
          logger.warn(
            { module: 'riot-id-tracker', telegramId: telegram_id, chatId, reason: 'user_not_found' },
            'User not found in chat (left?) — skipping',
          );
        } else if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
          // Wait and retry once
          logger.warn(
            { module: 'riot-id-tracker', telegramId: telegram_id, chatId },
            'Rate limited by Telegram — waiting 5s and retrying once',
          );
          await sleep(5000);
          try {
            await setCustomTitleInChat(chatId, telegram_id, title);
            chatsUpdated++;
          } catch (retryErr) {
            logger.warn(
              { module: 'riot-id-tracker', telegramId: telegram_id, chatId, err: retryErr },
              'Retry after 429 failed — skipping chat',
            );
          }
        } else {
          logger.warn(
            { module: 'riot-id-tracker', telegramId: telegram_id, chatId, err: chatErr },
            'Unexpected Telegram error when setting custom title — skipping chat',
          );
        }
      }
    }

    logger.info(
      {
        module: 'riot-id-tracker',
        telegramId: telegram_id,
        oldRiotId,
        newRiotId,
        chatsUpdated,
      },
      'Riot ID updated',
    );

    return { changed: true, chatsUpdated };
  }

  async function refreshAll(): Promise<void> {
    const tick_started_at = Date.now();

    const allUsers: UserRow[] = await db
      .select({
        telegram_id: users.telegram_id,
        riot_puuid: users.riot_puuid,
        riot_name: users.riot_name,
        riot_tag: users.riot_tag,
        riot_lookup_failed_since: users.riot_lookup_failed_since,
      })
      .from(users)
      .where(isNotNull(users.riot_puuid));

    let total_changed = 0;
    let total_chats_updated = 0;

    for (let i = 0; i < allUsers.length; i++) {
      const user = allUsers[i] as UserRow;
      try {
        const result = await refreshUser(user);
        if (result.changed) {
          total_changed++;
          total_chats_updated += result.chatsUpdated;
        }
      } catch (err) {
        logger.warn(
          { module: 'riot-id-tracker', telegramId: user.telegram_id, err },
          'Unexpected error processing user — skipping',
        );
      }

      if (i < allUsers.length - 1) {
        await sleep(DEFAULT_SLEEP_MS);
      }
    }

    const tick_ended_at = Date.now();

    logger.info(
      {
        module: 'riot-id-tracker',
        tick_finished: true,
        total_users: allUsers.length,
        total_changed,
        total_chats_updated,
        duration_ms: tick_ended_at - tick_started_at,
      },
      'Riot ID tracker tick complete',
    );
  }

  return { refreshAll, refreshUser };
}

export interface StartRiotIdTrackerLoopDeps extends RiotIdTrackerDeps {
  /** Override cron expression for tests. */
  intervalCron?: string;
}

/** Returns a stop function for graceful shutdown. */
export function startRiotIdTrackerLoop(deps: StartRiotIdTrackerLoopDeps): () => void {
  const { refreshAll } = makeRiotIdTracker(deps);
  const cronExpr = deps.intervalCron ?? '0 6 * * *';

  const cronJob = new Cron(
    cronExpr,
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void refreshAll();
    },
  );

  logger.info({ module: 'riot-id-tracker', cron: cronExpr }, 'Riot ID tracker cron started');

  return function stopRiotIdTrackerLoop() {
    cronJob.stop();
    logger.info({ module: 'riot-id-tracker' }, 'Riot ID tracker loop stopped');
  };
}
