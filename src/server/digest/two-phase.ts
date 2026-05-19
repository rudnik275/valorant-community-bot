/**
 * two-phase.ts — the weekly digest's two-phase prepare/publish flow (#227).
 *
 * The weekly digest gets a promo image, which needs the digest text in its
 * prompt — so generation must happen *before* publication. Splitting one
 * weekly cron tick into two:
 *
 *   - PREPARE  (Fri 18:45 Kyiv, new Croner job) — build the digest once,
 *     stash `prepared_text` + topAgent/topMap in `digest_runs`, generate the
 *     PNG, stash it on disk + record `story_image_path`.
 *   - PUBLISH  (Fri 19:00 Kyiv, the existing weekly cron via the
 *     `publishOverride` hook) — post the *saved* `prepared_text` verbatim,
 *     record published-state IMMEDIATELY (mirrors #255), then best-effort
 *     reply the PNG as a photo. Image failure never touches published state.
 *
 * Friday 18:45 and Friday 19:00 are the same ISO week, so `getDigestNowKyiv`
 * yields the same `weekIso` → the prepare→publish handoff key is stable
 * (validated by the prototype, see src/server/story/NOTES.md).
 *
 * Daily digest is untouched: it never sets `publishOverride` and never runs
 * this prepare loop (HARD INVARIANT #1).
 *
 * 8b (crash between text-send and the published-state write) is ACCEPTED
 * as-is — no `publishing` intent marker (NOTES.md / issue #227 §3).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Cron } from 'croner';
import { digestRuns } from '../db/schema/digest_runs.ts';
import { buildDigest } from './build.ts';
import { getDigestNowKyiv, type DigestNowKyiv } from './loop.ts';
import { runStoryGeneration } from '../story/run.ts';
import { isPublishingEnabled } from '../lib/silent-period.ts';
import type { SendMessage } from '../lib/scheduled-digest.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** Marker text used for an empty week (mirrors the weekly spec's marker). */
const NO_CONTENT_MARKER = '[no_content]';

/** Where prepared promo PNGs are stashed (Docker volume in prod). */
function storiesDir(): string {
  return process.env['STORIES_DIR'] ?? '/app/data/stories';
}

/** Max image-generation attempts on the prepare tick (no delay, then give up). */
const MAX_IMAGE_ATTEMPTS = 2;

interface DigestRunRow {
  id: number;
  week_iso: string;
  posted_at: number | null;
  posted_message_id: number | null;
  posted_text: string | null;
  prepared_text: string | null;
  prepared_top_agent: string | null;
  prepared_top_map: string | null;
  story_image_path: string | null;
}

async function findRow(db: AnyDb, weekIso: string): Promise<DigestRunRow | undefined> {
  const [row] = await db
    .select()
    .from(digestRuns)
    .where(eq(digestRuns.week_iso, weekIso))
    .limit(1);
  return row as DigestRunRow | undefined;
}

// ─── Photo-send injection ────────────────────────────────────────────────────

/**
 * Best-effort photo reply. Injected (bound to `bot.api` + the exempt path in
 * index.ts) so this module stays free of grammY. Returns void; the caller
 * treats any throw as "image failed, published state unchanged".
 */
export type SendPhotoReply = (
  chatId: number,
  buffer: Buffer,
  name: string,
  replyToMessageId: number,
) => Promise<void>;

export interface PrepareLoopDeps {
  db: AnyDb;
  getPrimaryChatId: () => number;
  /** Resolve the OpenAI key at tick time (empty ⇒ skip image, text-only). */
  getOpenAIKey: () => string;
  /** Injectable now-in-Kyiv (test). Defaults to getDigestNowKyiv. */
  getNowKyiv?: () => DigestNowKyiv;
  /** Prepare cron expression. Default `45 18 * * 5` Europe/Kyiv. */
  prepareCron?: string;
}

export interface PublishOverrideDeps {
  db: AnyDb;
  sendMessage: SendMessage;
  getPrimaryChatId: () => number;
  sendPhotoReply: SendPhotoReply;
}

// ─── PREPARE tick ────────────────────────────────────────────────────────────

/**
 * One prepare tick (Fri 18:45 Kyiv). Idempotent; safe under a double cron
 * fire. Never throws image failures up — the digest text fate is sealed the
 * moment the `prepared` row is written, before any image work.
 */
export async function runPrepareTick(deps: PrepareLoopDeps): Promise<void> {
  const getNowKyiv = deps.getNowKyiv ?? getDigestNowKyiv;
  const { weekIso, weekStart, weekEnd, nowMs } = getNowKyiv();

  try {
    // 1. Dedup: a prepared|published row already exists → no-op.
    const existing = await findRow(deps.db, weekIso);
    if (existing && (existing.prepared_text !== null || existing.posted_at !== null)) {
      logger.info(
        { module: 'digest_prepare', week_iso: weekIso },
        'Prepare tick — digest already prepared/published this week, no-op',
      );
      return;
    }
    // A [no_content] / [silent-period] marker row also means "handled".
    if (existing && existing.posted_text !== null) {
      logger.info(
        { module: 'digest_prepare', week_iso: weekIso, marker: existing.posted_text },
        'Prepare tick — marker row already recorded this week, no-op',
      );
      return;
    }

    // 2. Build the digest once.
    const { text, topAgent, topMap } = await buildDigest({
      db: deps.db,
      weekStart,
      weekEnd,
    });

    // 3. Empty week → record the [no_content] marker, stop (no image).
    if (text === null) {
      await deps.db
        .insert(digestRuns)
        .values({ week_iso: weekIso, started_at: nowMs, posted_text: NO_CONTENT_MARKER })
        .onConflictDoNothing();
      logger.info(
        { module: 'digest_prepare', week_iso: weekIso },
        'Prepare tick — no content, recorded marker',
      );
      return;
    }

    // 4. Write the `prepared` row. From here the TEXT is committed
    //    regardless of the image's fate (HARD INVARIANT #4).
    await deps.db
      .insert(digestRuns)
      .values({
        week_iso: weekIso,
        started_at: nowMs,
        prepared_text: text,
        prepared_top_agent: topAgent,
        prepared_top_map: topMap,
        story_image_path: null,
      })
      .onConflictDoNothing();
    logger.info(
      { module: 'digest_prepare', week_iso: weekIso, top_agent: topAgent, top_map: topMap },
      'Prepare tick — prepared row written (text committed)',
    );

    // 5. No OpenAI key → warn, skip image (text-only at 19:00).
    const apiKey = deps.getOpenAIKey();
    if (!apiKey) {
      logger.warn(
        { module: 'digest_prepare', week_iso: weekIso },
        'No OPENAI_API_KEY — skipping promo image (digest will post text-only)',
      );
      return;
    }

    // 6 + 7. Resolve refs + generate with a short retry (MAX 2, no delay),
    //         then give up SILENTLY. Image failure never blocks the text.
    let buffer: Buffer | null = null;
    for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt++) {
      try {
        const result = await runStoryGeneration({
          topAgent,
          topMap,
          digestText: text,
          apiKey,
        });
        if (result.buffer === null) {
          // Missing reference PNG — runStoryGeneration already warned with
          // the agent/map name. Not retryable; post text-only.
          return;
        }
        buffer = result.buffer;
        break;
      } catch (err) {
        logger.warn(
          { module: 'digest_prepare', week_iso: weekIso, attempt, err },
          'Promo-image generation attempt failed',
        );
        if (attempt >= MAX_IMAGE_ATTEMPTS) {
          logger.warn(
            { module: 'digest_prepare', week_iso: weekIso },
            'Promo-image generation gave up after retries — digest will post text-only',
          );
          return; // give up silently — text already committed
        }
      }
    }
    if (buffer === null) return;

    // 8. Success → stash the PNG + record story_image_path.
    const dir = storiesDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${weekIso}.png`);
    await writeFile(path, buffer);
    await deps.db
      .update(digestRuns)
      .set({ story_image_path: path })
      .where(eq(digestRuns.week_iso, weekIso));
    logger.info(
      { module: 'digest_prepare', week_iso: weekIso, story_image_path: path },
      'Prepare tick — promo image stashed',
    );
  } catch (err) {
    // Unexpected-error boundary — the digest text is either already
    // committed (prepared row written) or will be freshly built at 19:00.
    logger.error(
      { module: 'digest_prepare', week_iso: weekIso, err },
      'Prepare tick failed unexpectedly',
    );
  }
}

/**
 * Register the prepare cron (`45 18 * * 5` Europe/Kyiv, protect:true) —
 * mirrors `startScheduledDigest`. Returns a stop function.
 */
export function startPrepareLoop(deps: PrepareLoopDeps): () => void {
  const cron = deps.prepareCron ?? '45 18 * * 5';
  const job = new Cron(cron, { timezone: 'Europe/Kyiv', protect: true }, () => {
    void runPrepareTick(deps);
  });
  logger.info(
    { module: 'digest_prepare', cron, tz: 'Europe/Kyiv' },
    'Weekly digest prepare loop started',
  );
  return function stopPrepareLoop() {
    job.stop();
    logger.info({ module: 'digest_prepare' }, 'Weekly digest prepare loop stopped');
  };
}

// ─── PUBLISH override (Fri 19:00, runs inside runScheduledDigest) ─────────────

/**
 * Build the `publishOverride` for the weekly `DigestSpec`. The shared
 * `runScheduledDigest` calls this after the unexpected-error boundary + the
 * Silent-period gate (weekly has `silentPeriodGate: true`).
 *
 * Branching keyed on the `digest_runs` row for this `weekIso`:
 *   - published (posted_at set)         → no-op (dedup).
 *   - [no_content] / [silent-period]    → post nothing (current behaviour).
 *   - prepared row exists               → post prepared_text → record
 *       published-state IMMEDIATELY (#255 ordering) → best-effort photo
 *       reply (failure logged, does NOT touch published state).
 *   - no row at all (prepare missed)    → fresh buildDigest() + text-only,
 *       no image (digest always goes out on time).
 */
export function makeWeeklyPublishOverride(sendPhotoReply: SendPhotoReply) {
  return async (
    db: AnyDb,
    w: { dedupKey: string; nowMs: number; windowStart: number; windowEnd: number },
    deps: { sendMessage: SendMessage; getPrimaryChatId: () => number },
  ): Promise<void> => {
    const weekIso = w.dedupKey;
    const row = await findRow(db, weekIso);

    // Already published this week → no-op (dedup; covers double 19:00 tick).
    if (row && row.posted_at !== null) {
      logger.info(
        { module: 'digest_publish', week_iso: weekIso },
        'Publish tick — already published this week, no-op',
      );
      return;
    }

    // [no_content] / [silent-period] marker recorded at prepare → post nothing.
    if (row && row.posted_text !== null && row.prepared_text === null) {
      logger.info(
        { module: 'digest_publish', week_iso: weekIso, marker: row.posted_text },
        'Publish tick — marker row, posting nothing (current behaviour)',
      );
      return;
    }

    const chatId = deps.getPrimaryChatId();

    // No row at all → the prepare tick was missed (deploy/restart/crash in
    // the 18:45–19:00 window). Fresh build, TEXT-ONLY, on time.
    if (!row || row.prepared_text === null) {
      const { text } = await buildDigest({
        db,
        weekStart: w.windowStart,
        weekEnd: w.windowEnd,
      });
      if (text === null) {
        await db
          .insert(digestRuns)
          .values({ week_iso: weekIso, started_at: w.nowMs, posted_text: NO_CONTENT_MARKER })
          .onConflictDoNothing();
        logger.info(
          { module: 'digest_publish', week_iso: weekIso },
          'Publish tick — prepare missed, fresh build empty, recorded marker',
        );
        return;
      }
      const { message_id: messageId } = await deps.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      await db
        .insert(digestRuns)
        .values({
          week_iso: weekIso,
          started_at: w.nowMs,
          posted_at: Date.now(),
          posted_message_id: messageId,
          posted_text: text,
        })
        .onConflictDoNothing();
      logger.info(
        { module: 'digest_publish', week_iso: weekIso, message_id: messageId },
        'Publish tick — prepare missed, posted fresh text-only digest',
      );
      return;
    }

    // Prepared row exists → post the SAVED text verbatim.
    const preparedText = row.prepared_text;
    const { message_id: messageId } = await deps.sendMessage(chatId, preparedText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    // #255 ordering: record published-state IMMEDIATELY after the text send,
    // BEFORE the best-effort image. The image is purely additive.
    const postedAt = Date.now();
    await db
      .update(digestRuns)
      .set({
        posted_at: postedAt,
        posted_message_id: messageId,
        posted_text: preparedText,
      })
      .where(eq(digestRuns.week_iso, weekIso));
    logger.info(
      { module: 'digest_publish', week_iso: weekIso, message_id: messageId },
      'Publish tick — posted prepared text, published-state recorded',
    );

    // Best-effort photo reply. Any failure is logged and swallowed — it
    // must NOT change the already-published state (HARD INVARIANT #2/#5).
    if (row.story_image_path) {
      try {
        const { readFile } = await import('node:fs/promises');
        const buffer = await readFile(row.story_image_path);
        await sendPhotoReply(chatId, buffer, `${weekIso}.png`, messageId);
        logger.info(
          { module: 'digest_publish', week_iso: weekIso, message_id: messageId },
          'Publish tick — promo image photo-reply sent',
        );
      } catch (err) {
        logger.warn(
          { module: 'digest_publish', week_iso: weekIso, err },
          'Publish tick — promo image photo-reply failed (digest already published, ignoring)',
        );
      }
    } else {
      logger.info(
        { module: 'digest_publish', week_iso: weekIso },
        'Publish tick — no promo image for this week (text-only digest already sent)',
      );
    }
  };
}
