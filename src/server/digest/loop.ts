/**
 * loop.ts — Weekly digest adapter over the shared scheduled-digest module.
 *
 * Thin adapter: supplies only what differs for the weekly digest — the
 * cron expression (`WEEKLY_DIGEST_CRON`, Sun 19:00 Europe/Kyiv), the rolling
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
  type SendRichMessage,
} from '../lib/scheduled-digest.ts';
import { computeWeekIso, digestWeekStartFor, WEEKLY_DIGEST_CRON } from '../lib/kyiv-week.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DigestLoopDeps {
  db: AnyDb;
  sendMessage: SendMessage;
  /**
   * Rich Message send (#309) — `sendRichMessage` via grammY's raw proxy,
   * wired in index.ts. When present, the weekly publish path posts the digest
   * as a rich message, falling back to `sendMessage` (legacy text) on any
   * error. When absent, the publish path is legacy text only.
   */
  sendRichMessage?: SendRichMessage;
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
   * Computed as the ISO week of the publication moment (Sunday).
   * Sunday closes its ISO week, which runs from the preceding Monday (ISO 8601).
   * Used as the UNIQUE key in digest_runs to prevent duplicate digests per cycle.
   */
  weekIso: string;
  /**
   * Window start: the same Kyiv wall-clock time 7 calendar days before weekEnd
   * (167h/168h/169h across DST, ms) — or the last Friday digest, for the first
   * Sunday window (see `digestWeekStartFor`).
   */
  weekStart: number;
  /** Window end: the publication moment snapped down to the start of its Kyiv minute (ms). */
  weekEnd: number;
}

/**
 * Compute rolling 7-day window info anchored to the current moment (publication time).
 *
 * New window logic (post-#149):
 *   weekEnd   = the publication tick (Sunday 19:00 Kyiv), snapped to its minute
 *   weekStart = the same wall-clock moment 7 Kyiv calendar days earlier (the
 *               first Sunday window reaches back to the last Friday digest)
 *
 * The window is anchored to the Kyiv wall clock, not to a fixed 7×86_400_000,
 * because the cron itself is local-time — see the comment at the computation.
 *
 * weekIso = ISO week of the publication day (Sunday).
 * ISO 8601: Sunday is in the same week as the preceding Monday (weeks start Mon).
 * This is used as the UNIQUE key in digest_runs — prevents duplicate digests per Sunday cycle.
 *
 * We compute ISO week via Thursday-anchor method (standard ISO 8601 algorithm).
 */
export function getDigestNowKyiv(nowMs?: number): DigestNowKyiv {
  const ms = nowMs ?? Date.now();

  // Snap the window boundaries to the start of the Kyiv minute the tick fired
  // in. Croner hands us the true Date.now(), so two consecutive ticks differ by
  // a few ms of scheduling jitter; without the snap consecutive windows miss
  // (or overlap) by that jitter and an event landing in it is dropped (or
  // rendered twice). `nowMs` stays the true instant — it is what
  // `digest_runs.started_at` and the Silent-period gate read.
  const weekEndMs = Math.floor(ms / 60000) * 60000;
  // Seven Kyiv CALENDAR days back, so the window matches the local-time cron's
  // own cadence across DST — `digestWeekStartFor` explains why, and how the
  // first Sunday window reaches back to the last Friday digest.
  const weekStartMs = digestWeekStartFor(weekEndMs);

  // ISO week of the publication moment — the UNIQUE dedup key in digest_runs,
  // and (via buildDigest) the `weekly_records.week_iso` this window writes.
  // `records-rebuild.ts` names the same window the same way; both go through
  // `lib/kyiv-week.ts` so they can never drift apart again.
  const weekIso = computeWeekIso(ms);

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
    cron: WEEKLY_DIGEST_CRON,
    silentPeriodGate: true,
    healthcheckUrl,
    ...(publishOverride ? { publishOverride } : {}),
    resolveWindow: (): DigestWindow => {
      const { nowMs, weekIso, weekStart, weekEnd } = getNowKyiv();
      return { nowMs, windowStart: weekStart, windowEnd: weekEnd, dedupKey: weekIso };
    },
    build: async (db, w) => {
      const { text, richHtml, sectionsIncluded } = await buildDigest({
        db,
        weekStart: w.windowStart,
        weekEnd: w.windowEnd,
      });
      // Thread richHtml through meta so recordSuccess can persist it on the
      // non-override path (#309). (The override path persists it directly.)
      return { text, meta: { sectionsIncluded, richHtml } };
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
      const { sectionsIncluded, richHtml } = meta as {
        sectionsIncluded: string[];
        richHtml: string | null;
      };
      await db
        .insert(digestRuns)
        .values({
          week_iso: w.dedupKey,
          started_at: w.nowMs,
          posted_at: sent.postedAt,
          posted_message_id: sent.messageId,
          posted_text: sent.text,
          rich_html: richHtml,
        })
        .onConflictDoNothing();
      logger.info(
        { module: 'digest', week_iso: w.dedupKey, sections: sectionsIncluded },
        'Weekly digest sections recorded',
      );
    },
  };
}

export async function runDigestNow(deps: DigestLoopDeps): Promise<void> {
  await runScheduledDigest(makeWeeklySpec(deps), {
    db: deps.db,
    sendMessage: deps.sendMessage,
    ...(deps.sendRichMessage ? { sendRichMessage: deps.sendRichMessage } : {}),
    getPrimaryChatId: deps.getPrimaryChatId,
  });
}

export function startDigestLoop(deps: DigestLoopDeps): () => void {
  return startScheduledDigest(makeWeeklySpec(deps), {
    db: deps.db,
    sendMessage: deps.sendMessage,
    ...(deps.sendRichMessage ? { sendRichMessage: deps.sendRichMessage } : {}),
    getPrimaryChatId: deps.getPrimaryChatId,
  });
}

// Re-export the two-phase prepare loop + photo-reply type so index.ts wires
// the weekly promo image (#227) from one place.
export { startPrepareLoop, type PrepareLoopDeps, type SendPhotoReply } from './two-phase.ts';

// Re-export for convenience in index.ts
export { sql };
