/**
 * loop.ts — Daily ace digest scheduler.
 *
 * Cron '0 23 * * *' with timezone Europe/Kyiv.
 * Posts grouped ace digest to the primary chat every day at 23:00.
 *
 * Idempotency: dedup via daily_digest_runs.run_date UNIQUE — safe against
 * container restarts that land exactly on the cron minute.
 *
 * If zero aces — no message sent; a row still recorded so subsequent re-runs
 * the same day are no-ops.
 */

import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { dailyDigestRuns } from '../db/schema/daily_digest_runs.ts';
import { buildDailyAceDigest } from './build.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DailyDigestLoopDeps {
  db: AnyDb;
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
  ) => Promise<{ message_id: number }>;
  getPrimaryChatId?: () => number;
  intervalCron?: string; // default '0 23 * * *' Europe/Kyiv
}

/**
 * Compute the Kyiv calendar date as a YYYY-MM-DD string for the given ms epoch.
 * Used as the unique run_date key in daily_digest_runs.
 */
export function getKyivDate(nowMs?: number): string {
  const ms = nowMs ?? Date.now();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(ms); // returns YYYY-MM-DD (en-CA locale)
}

export async function runDailyDigestNow(deps: DailyDigestLoopDeps): Promise<void> {
  const { db, sendMessage, getPrimaryChatId } = deps;

  try {
    const nowMs = Date.now();
    const runDate = getKyivDate(nowMs);

    // Check idempotency: if we already ran today, skip
    const [existing] = await db
      .select({ id: dailyDigestRuns.id })
      .from(dailyDigestRuns)
      .where(eq(dailyDigestRuns.run_date, runDate))
      .limit(1);

    if (existing) {
      logger.info(
        { module: 'digest-daily', run_date: runDate },
        'Daily ace digest already ran today — skipping (idempotent)',
      );
      return;
    }

    // Window: last 24 hours ending now
    const windowEnd = nowMs;
    const windowStart = windowEnd - 24 * 3600 * 1000;

    // Insert run row as a "lock" — if another tick races, the UNIQUE constraint
    // on run_date will reject the second insert.
    try {
      await db.insert(dailyDigestRuns).values({
        run_date: runDate,
        started_at: nowMs,
      });
    } catch {
      // UNIQUE constraint violation → another tick won the race, bail out
      logger.info(
        { module: 'digest-daily', run_date: runDate },
        'Daily ace digest race — another tick already started, skipping',
      );
      return;
    }

    const { text, includedEventIds } = await buildDailyAceDigest({ db, windowStart, windowEnd });

    if (text === null) {
      // Zero aces — update the row to mark completion (no post)
      await db
        .update(dailyDigestRuns)
        .set({ posted_at: Date.now() })
        .where(eq(dailyDigestRuns.run_date, runDate));
      logger.info(
        { module: 'digest-daily', run_date: runDate },
        'Daily ace digest: zero aces in window — row recorded, no message sent',
      );
      return;
    }

    const chatId = getPrimaryChatId ? getPrimaryChatId() : 0;
    const { message_id: messageId } = await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const postedAt = Date.now();
    await db
      .update(dailyDigestRuns)
      .set({
        posted_at: postedAt,
        posted_message_id: messageId,
        posted_text: text,
        included_event_ids: JSON.stringify(includedEventIds),
      })
      .where(eq(dailyDigestRuns.run_date, runDate));

    logger.info(
      {
        module: 'digest-daily',
        run_date: runDate,
        chat_id: chatId,
        message_id: messageId,
        ace_count: includedEventIds.length,
      },
      'Daily ace digest posted successfully',
    );
  } catch (err) {
    logger.error({ module: 'digest-daily', err }, 'Daily ace digest tick failed unexpectedly');
  }
}

export function startDailyDigestLoop(deps: DailyDigestLoopDeps): () => void {
  const cronExpr = deps.intervalCron ?? '0 23 * * *';
  const cronJob = new Cron(
    cronExpr,
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runDailyDigestNow(deps);
    },
  );

  logger.info({ module: 'digest-daily', cron: cronExpr, tz: 'Europe/Kyiv' }, 'Daily ace digest loop started');

  return function stopDailyDigestLoop() {
    cronJob.stop();
    logger.info({ module: 'digest-daily' }, 'Daily ace digest loop stopped');
  };
}
