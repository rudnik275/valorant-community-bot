/**
 * loop.ts — Daily ace digest adapter over the shared scheduled-digest module.
 *
 * Thin adapter: supplies only what differs for the daily digest — the
 * cron expression (`0 23 * * *`, 23:00 Europe/Kyiv), the trailing-24h
 * window + Kyiv-date dedup key, the `buildDailyAceDigest` call, and the
 * `daily_digest_runs` persistence. Cron registration and the idempotency
 * ordering live in `../lib/scheduled-digest.ts`.
 *
 * Idempotency: dedup via daily_digest_runs.run_date UNIQUE — safe against
 * container restarts that land exactly on the cron minute.
 *
 * The Silent-period gate and the Healthchecks.io ping do NOT apply to the
 * daily digest (unchanged from the original loop).
 *
 * ─── Idempotency-ordering change (issue #255) ─────────────────────────────
 *
 * The original daily loop inserted a lock row BEFORE the build (one-loss-on-
 * crash: a crash after the lock but before the post lost that day's digest
 * forever). It now follows the SHARED no-dup-on-crash contract: the run row
 * is recorded only AFTER a fully successful send. A crash mid-build/mid-send
 * leaves no row, so the next cron tick re-attempts — at most one tick late,
 * never silently lost. (See the scheduled-digest module doc-comment for the
 * full rationale.) Observable posting behaviour is otherwise identical:
 * one post per Kyiv date, zero-ace days still record a row with `posted_at`
 * set and no message.
 *
 * Zero aces: no message sent; a row is still recorded (posted_at set,
 * posted_text NULL) so subsequent re-runs the same day are no-ops.
 */

import { eq } from 'drizzle-orm';
import { dailyDigestRuns } from '../db/schema/daily_digest_runs.ts';
import { buildDailyAceDigest } from './build.ts';
import {
  runScheduledDigest,
  startScheduledDigest,
  type DigestSpec,
  type DigestWindow,
  type SendMessage,
} from '../lib/scheduled-digest.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DailyDigestLoopDeps {
  db: AnyDb;
  sendMessage: SendMessage;
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

/**
 * Build the daily `DigestSpec` — the only daily-specific knowledge:
 * cron, trailing-24h window + Kyiv-date dedup key, the `buildDailyAceDigest`
 * call, and `daily_digest_runs` persistence. Silent-period + Healthchecks
 * do NOT apply to the daily digest.
 */
function makeDailySpec(deps: DailyDigestLoopDeps): DigestSpec {
  const cron = deps.intervalCron ?? '0 23 * * *';

  return {
    module: 'digest-daily',
    cron,
    silentPeriodGate: false,
    healthcheckUrl: undefined,
    resolveWindow: (): DigestWindow => {
      const nowMs = Date.now();
      return {
        nowMs,
        windowStart: nowMs - 24 * 3600 * 1000,
        windowEnd: nowMs,
        dedupKey: getKyivDate(nowMs),
      };
    },
    build: async (db, w) => {
      const { text, includedEventIds } = await buildDailyAceDigest({
        db,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      });
      return { text, meta: includedEventIds };
    },
    findExisting: async (db, runDate) => {
      const [existing] = await db
        .select({ id: dailyDigestRuns.id })
        .from(dailyDigestRuns)
        .where(eq(dailyDigestRuns.run_date, runDate))
        .limit(1);
      return existing;
    },
    // Zero-ace ("[no_content]") day: record a row so re-runs are no-ops.
    // Daily semantics differ from weekly markers — posted_at is SET (the day
    // was handled) but posted_text stays NULL (no message existed).
    recordMarker: async (db, w) => {
      await db
        .insert(dailyDigestRuns)
        .values({
          run_date: w.dedupKey,
          started_at: w.nowMs,
          posted_at: Date.now(),
        })
        .onConflictDoNothing();
    },
    recordSuccess: async (db, w, sent, meta) => {
      await db
        .insert(dailyDigestRuns)
        .values({
          run_date: w.dedupKey,
          started_at: w.nowMs,
          posted_at: sent.postedAt,
          posted_message_id: sent.messageId,
          posted_text: sent.text,
          included_event_ids: JSON.stringify(meta as number[]),
        })
        .onConflictDoNothing();
    },
  };
}

function depsForRun(deps: DailyDigestLoopDeps) {
  return {
    db: deps.db,
    sendMessage: deps.sendMessage,
    getPrimaryChatId: deps.getPrimaryChatId ?? (() => 0),
  };
}

export async function runDailyDigestNow(deps: DailyDigestLoopDeps): Promise<void> {
  await runScheduledDigest(makeDailySpec(deps), depsForRun(deps));
}

export function startDailyDigestLoop(deps: DailyDigestLoopDeps): () => void {
  return startScheduledDigest(makeDailySpec(deps), depsForRun(deps));
}
