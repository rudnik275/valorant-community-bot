/**
 * loop.ts — Digest scheduler: posts weekly aggregate to primary chat.
 *
 * Croner '0 19 * * 5' (Friday 19:00) with timezone Europe/Kyiv.
 *
 * Idempotency: dedup via digest_runs.week_iso UNIQUE — safe against
 * container restarts that land exactly on the cron minute.
 *
 * Silent-period gate: if EVENTS_PUBLISHING_ENABLED_AFTER > now → insert
 * digest_runs row with marker '[silent-period]' and return (no post).
 *
 * Healthchecks.io: fire-and-forget fetch to HEALTHCHECK_DIGEST_URL if set.
 */

import { Cron } from 'croner';
import { eq, sql } from 'drizzle-orm';
import { digestRuns } from '../db/schema/digest_runs.ts';
import { buildDigest } from './build.ts';
import logger from '../lib/log.ts';
import { isPublishingEnabled } from '../lib/silent-period.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DigestLoopDeps {
  db: AnyDb;
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
  ) => Promise<{ message_id: number }>;
  getPrimaryChatId: () => number;
  /** Healthchecks.io URL. Defaults to HEALTHCHECK_DIGEST_URL env var. */
  healthcheckUrl?: string;
  /** Injectable now-in-Kyiv for testing. Returns { nowMs, weekIso, weekStart, weekEnd }. */
  getNowKyiv?: () => DigestNowKyiv;
}

export interface DigestNowKyiv {
  /** Current Unix ms. */
  nowMs: number;
  /**
   * ISO week string e.g. "2026-W19".
   * Computed as the ISO week of the publication moment (Friday).
   * Friday is in the same ISO week as the preceding Monday by ISO 8601 convention.
   * Used as the UNIQUE key in digest_runs to prevent duplicate digests per cycle.
   */
  weekIso: string;
  /** Window start: now - 7 days (rolling 7-day window, ms). */
  weekStart: number;
  /** Window end: now (publication moment, ms). */
  weekEnd: number;
}

/**
 * Compute rolling 7-day window info anchored to the current moment (publication time).
 *
 * New window logic (post-#149):
 *   weekEnd   = now (the publication moment — Friday 19:00 Kyiv)
 *   weekStart = weekEnd - 7 * 86400000 (rolling 7-day window)
 *
 * weekIso = ISO week of the publication day (Friday).
 * ISO 8601: Friday is in the same week as the preceding Monday (weeks start Mon).
 * This is used as the UNIQUE key in digest_runs — prevents duplicate digests per Friday cycle.
 *
 * We compute ISO week via Thursday-anchor method (standard ISO 8601 algorithm).
 */
export function getDigestNowKyiv(nowMs?: number): DigestNowKyiv {
  const ms = nowMs ?? Date.now();

  // Rolling 7-day window: end = now, start = now - 7 days
  const weekEndMs = ms;
  const weekStartMs = ms - 7 * 86400000;

  // Compute ISO week of the publication moment (for UNIQUE dedup key)
  // We need the day-of-week in Kyiv to find the Monday of this ISO week, then Thursday-anchor.
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmtDate.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const fmtWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    weekday: 'short',
  });
  const weekdayStr = fmtWeekday.format(ms);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[weekdayStr] ?? 0;

  // Find Monday midnight of the ISO week containing `ms`
  const todayMidnightMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayMs = todayMidnightMs - daysFromMonday * 86400000;

  // ISO week number via Thursday anchor
  const thursdayMs = mondayMs + 3 * 86400000;
  const thursdayDate = new Date(thursdayMs);
  const thurYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(thurYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay();
  const jan4Monday = jan4 - (jan4Weekday === 0 ? 6 : jan4Weekday - 1) * 86400000;
  const weekNumber = Math.floor((thursdayMs - jan4Monday) / (7 * 86400000)) + 1;
  const weekIso = `${thurYear}-W${String(weekNumber).padStart(2, '0')}`;

  return { nowMs: ms, weekIso, weekStart: weekStartMs, weekEnd: weekEndMs };
}

export async function runDigestNow(deps: DigestLoopDeps): Promise<void> {
  const { db, sendMessage, getPrimaryChatId } = deps;

  const getNowKyiv = deps.getNowKyiv ?? getDigestNowKyiv;

  const healthcheckUrl = deps.healthcheckUrl ?? process.env['HEALTHCHECK_DIGEST_URL'];

  try {
    const { nowMs, weekIso, weekStart, weekEnd } = getNowKyiv();

    // Check silent period
    if (!isPublishingEnabled(new Date(nowMs))) {
      // Insert a row so we don't retry in the same week
      try {
        await db.insert(digestRuns).values({
          week_iso: weekIso,
          started_at: nowMs,
          posted_text: '[silent-period]',
        });
      } catch {
        // UNIQUE constraint violation → row already exists, that's fine
      }
      logger.info({ module: 'digest', week_iso: weekIso }, 'Digest skipped — silent period active');
      return;
    }

    // Dedup: check if already ran this week
    const [existing] = await db
      .select({ id: digestRuns.id })
      .from(digestRuns)
      .where(eq(digestRuns.week_iso, weekIso))
      .limit(1);

    if (existing) {
      logger.info({ module: 'digest', week_iso: weekIso }, 'Digest already posted this week — skipping (idempotent)');
      return;
    }

    // Insert started_at row
    const insertResult = await db
      .insert(digestRuns)
      .values({ week_iso: weekIso, started_at: nowMs })
      .returning({ id: digestRuns.id });

    const runId = insertResult[0]?.id as number;

    if (!runId) {
      logger.error({ module: 'digest', week_iso: weekIso }, 'Failed to insert digest_runs row');
      return;
    }

    // Build digest content
    const { text, sectionsIncluded } = await buildDigest({ db, weekStart, weekEnd });

    if (text === null) {
      logger.info({ module: 'digest', week_iso: weekIso, skipped: 'no_content' }, 'Digest has no content — not posting');
      await db
        .update(digestRuns)
        .set({ posted_text: '[no_content]' })
        .where(eq(digestRuns.id, runId));
      return;
    }

    // Post to primary chat
    const chatId = getPrimaryChatId();
    const { message_id: messageId } = await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const postedAt = Date.now();
    await db
      .update(digestRuns)
      .set({
        posted_at: postedAt,
        posted_message_id: messageId,
        posted_text: text,
      })
      .where(eq(digestRuns.id, runId));

    logger.info(
      { module: 'digest', week_iso: weekIso, chat_id: chatId, message_id: messageId, sections: sectionsIncluded },
      'Weekly digest posted successfully',
    );

    // Healthchecks.io ping (fire-and-forget)
    if (healthcheckUrl) {
      fetch(healthcheckUrl).catch((err) => {
        logger.warn({ module: 'digest', err }, 'Healthchecks.io ping failed');
      });
    }
  } catch (err) {
    logger.error({ module: 'digest', err }, 'Digest tick failed unexpectedly');
  }
}

export function startDigestLoop(deps: DigestLoopDeps): () => void {
  const cronJob = new Cron(
    '0 19 * * 5',
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runDigestNow(deps);
    },
  );

  logger.info({ module: 'digest', cron: '0 19 * * 5', tz: 'Europe/Kyiv' }, 'Digest loop started');

  return function stopDigestLoop() {
    cronJob.stop();
    logger.info({ module: 'digest' }, 'Digest loop stopped');
  };
}

// Re-export for convenience in index.ts
export { sql };
