/**
 * loop.ts — Digest scheduler: posts weekly aggregate to primary chat.
 *
 * Croner '0 20 * * 0' (Sunday 20:00) with timezone Europe/Kyiv.
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
  /** ISO week string e.g. "2026-W19". */
  weekIso: string;
  /** Window start: Monday 00:00 Kyiv (ms). */
  weekStart: number;
  /** Window end: Sunday 00:00 Kyiv = today midnight (ms). */
  weekEnd: number;
}

/**
 * Compute ISO 8601 week info anchored to Europe/Kyiv, based on the current moment.
 *
 * ISO 8601: weeks start on Monday; week 1 is the week containing the first Thursday.
 * Thursday-anchored: add 3 days to Monday to get Thursday, then derive week number.
 *
 * We approximate Kyiv timezone using UTC+3 for midnight boundaries (same approach as publisher).
 */
export function getDigestNowKyiv(nowMs?: number): DigestNowKyiv {
  const ms = nowMs ?? Date.now();

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = fmt.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);

  // Build today's midnight in Kyiv (UTC+3 approximation)
  const todayMidnightMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);

  // Day of week in Kyiv: 0=Sun,1=Mon,...,6=Sat
  const fmtWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    weekday: 'short',
  });
  const weekdayStr = fmtWeekday.format(ms);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[weekdayStr] ?? 0;

  // Monday of this ISO week (weekday 1)
  // If Sunday (0) → Monday was 6 days ago; if Mon (1) → 0 days ago; etc.
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const weekStartMs = todayMidnightMs - daysFromMonday * 86400000;
  // weekEnd = today midnight (the digest runs at 20:00 so "this week" = Mon to Sun 00:00)
  const weekEndMs = todayMidnightMs;

  // ISO week number via Thursday anchor
  const thursdayMs = weekStartMs + 3 * 86400000; // Thursday of this ISO week
  const thursdayDate = new Date(thursdayMs);
  const thurYear = thursdayDate.getUTCFullYear();
  // Week 1 is the week containing Jan 4 (first Thursday in year)
  const jan4 = Date.UTC(thurYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay();
  const jan4Monday = jan4 - (jan4Weekday === 0 ? 6 : jan4Weekday - 1) * 86400000;
  const weekNumber = Math.floor((thursdayMs - jan4Monday) / (7 * 86400000)) + 1;

  // If weekStart falls in previous year, use that year's week number
  // (handled via Thursday-anchor: thurYear already accounts for this)
  const weekIso = `${thurYear}-W${String(weekNumber).padStart(2, '0')}`;

  void year; void month; void day; // used indirectly via todayMidnightMs

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
    '0 20 * * 0',
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runDigestNow(deps);
    },
  );

  logger.info({ module: 'digest', cron: '0 20 * * 0', tz: 'Europe/Kyiv' }, 'Digest loop started');

  return function stopDigestLoop() {
    cronJob.stop();
    logger.info({ module: 'digest' }, 'Digest loop stopped');
  };
}

// Re-export for convenience in index.ts
export { sql };
