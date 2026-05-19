/**
 * loop.ts — Weekly digest adapter over the shared scheduled-digest module.
 *
 * Thin adapter: supplies only what differs for the weekly digest — the
 * cron expression (`0 19 * * 5`, Fri 19:00 Europe/Kyiv), the rolling
 * 7-day window + ISO-week dedup key, the `buildDigest` call, and the
 * `digest_runs` persistence. Cron registration, the Silent-period gate,
 * the Healthchecks.io ping, and the idempotency ordering all live in
 * `../lib/scheduled-digest.ts` (see its doc-comment for the
 * no-dup-on-crash contract — applied identically to weekly + daily).
 *
 * Idempotency: dedup via digest_runs.week_iso UNIQUE — safe against
 * container restarts that land exactly on the cron minute. The run row
 * is recorded only AFTER a fully successful send (no-dup-on-crash).
 *
 * Silent-period gate: if EVENTS_PUBLISHING_ENABLED_AFTER > now → record a
 * digest_runs row with marker '[silent-period]' and return (no post).
 *
 * Healthchecks.io: fire-and-forget fetch to HEALTHCHECK_DIGEST_URL if set.
 */

import { eq, sql } from 'drizzle-orm';
import { digestRuns } from '../db/schema/digest_runs.ts';
import { buildDigest } from './build.ts';
import logger from '../lib/log.ts';
import { makeWeeklyPublishOverride, type SendPhotoReply } from './two-phase.ts';
import {
  runScheduledDigest,
  startScheduledDigest,
  type DigestSpec,
  type DigestWindow,
  type SendMessage,
} from '../lib/scheduled-digest.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DigestLoopDeps {
  db: AnyDb;
  sendMessage: SendMessage;
  getPrimaryChatId: () => number;
  /** Healthchecks.io URL. Defaults to HEALTHCHECK_DIGEST_URL env var. */
  healthcheckUrl?: string;
  /** Injectable now-in-Kyiv for testing. Returns { nowMs, weekIso, weekStart, weekEnd }. */
  getNowKyiv?: () => DigestNowKyiv;
  /**
   * Best-effort photo-reply for the two-phase promo image (#227). When set,
   * the weekly publish path runs the two-phase override instead of the
   * shared no-dup-on-crash path: post saved `prepared_text` → record
   * published → best-effort photo reply. When absent (e.g. legacy callers /
   * unit tests that only exercise the text path), the weekly digest keeps
   * the original single-tick build+post behaviour.
   */
  sendPhotoReply?: SendPhotoReply;
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

/**
 * Build the weekly `DigestSpec` — the only weekly-specific knowledge:
 * cron, window/dedup-key, the `buildDigest` call, and `digest_runs`
 * persistence. The Silent-period gate + Healthchecks ping apply to weekly.
 */
function makeWeeklySpec(deps: DigestLoopDeps): DigestSpec {
  const getNowKyiv = deps.getNowKyiv ?? getDigestNowKyiv;
  const healthcheckUrl = deps.healthcheckUrl ?? process.env['HEALTHCHECK_DIGEST_URL'];

  const publishOverride = deps.sendPhotoReply
    ? makeWeeklyPublishOverride(deps.sendPhotoReply)
    : undefined;

  return {
    module: 'digest',
    cron: '0 19 * * 5',
    silentPeriodGate: true,
    healthcheckUrl,
    ...(publishOverride ? { publishOverride } : {}),
    resolveWindow: (): DigestWindow => {
      const { nowMs, weekIso, weekStart, weekEnd } = getNowKyiv();
      return { nowMs, windowStart: weekStart, windowEnd: weekEnd, dedupKey: weekIso };
    },
    build: async (db, w) => {
      const { text, sectionsIncluded } = await buildDigest({
        db,
        weekStart: w.windowStart,
        weekEnd: w.windowEnd,
      });
      return { text, meta: sectionsIncluded };
    },
    findExisting: async (db, weekIso) => {
      const [existing] = await db
        .select({ id: digestRuns.id })
        .from(digestRuns)
        .where(eq(digestRuns.week_iso, weekIso))
        .limit(1);
      return existing;
    },
    recordMarker: async (db, w, marker) => {
      await db
        .insert(digestRuns)
        .values({ week_iso: w.dedupKey, started_at: w.nowMs, posted_text: marker })
        .onConflictDoNothing();
    },
    recordSuccess: async (db, w, sent, meta) => {
      await db
        .insert(digestRuns)
        .values({
          week_iso: w.dedupKey,
          started_at: w.nowMs,
          posted_at: sent.postedAt,
          posted_message_id: sent.messageId,
          posted_text: sent.text,
        })
        .onConflictDoNothing();
      logger.info(
        { module: 'digest', week_iso: w.dedupKey, sections: meta as string[] },
        'Weekly digest sections recorded',
      );
    },
  };
}

export async function runDigestNow(deps: DigestLoopDeps): Promise<void> {
  await runScheduledDigest(makeWeeklySpec(deps), {
    db: deps.db,
    sendMessage: deps.sendMessage,
    getPrimaryChatId: deps.getPrimaryChatId,
  });
}

export function startDigestLoop(deps: DigestLoopDeps): () => void {
  return startScheduledDigest(makeWeeklySpec(deps), {
    db: deps.db,
    sendMessage: deps.sendMessage,
    getPrimaryChatId: deps.getPrimaryChatId,
  });
}

// Re-export the two-phase prepare loop + photo-reply type so index.ts wires
// the weekly promo image (#227) from one place.
export { startPrepareLoop, type PrepareLoopDeps, type SendPhotoReply } from './two-phase.ts';

// Re-export for convenience in index.ts
export { sql };
