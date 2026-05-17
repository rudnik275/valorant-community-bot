/**
 * scheduled-digest.ts — the one module behind both the weekly and the daily
 * digest. Owns the shared scaffold that used to be copy-pasted across
 * `digest/loop.ts` and `digest-daily/loop.ts`:
 *
 *   - cron registration (Croner, Europe/Kyiv, `protect: true`)
 *   - the idempotency contract (dedup-key lookup + run-row recording)
 *   - the optional Silent-period gate (`lib/silent-period.ts`)
 *   - the optional Healthchecks.io fire-and-forget ping
 *   - the unexpected-error boundary
 *
 * Weekly and daily are now THIN adapters (see `DigestSpec`) that supply only
 * what genuinely differs: the cron expression, the time window + dedup key,
 * the builder call, the run-row persistence (different tables/columns), and
 * two booleans (does the Silent-period gate apply? does the healthcheck ping
 * apply?).
 *
 * ─── Idempotency ordering (decided once, here, for BOTH digests) ──────────
 *
 * **Chosen ordering: record the run row only AFTER a fully successful send
 * (no-dup-on-crash).**
 *
 * Rationale: the two original loops disagreed — weekly recorded the row
 * *after* a successful send (no-dup-on-crash), daily inserted a lock row
 * *before* the build (one-loss-on-crash). That divergence was a latent
 * correctness trap. We unify on weekly's ordering because, for a chat-posted
 * digest, **a duplicate Telegram post is strictly worse than a one-tick-late
 * retry**: a crash between build and the dedup-row write merely means the next
 * cron tick re-attempts (the post is at most one tick late), whereas a
 * lock-before-build scheme silently *loses* a digest forever if the process
 * dies after the lock but before the post.
 *
 * Concretely, every `runScheduledDigest` invocation:
 *   1. resolves now → window + dedup key
 *   2. (weekly only) Silent-period gate: if disabled, record the
 *      `[silent-period]` marker row and return — no post
 *   3. dedup check: a run row already exists for this key → skip (idempotent)
 *   4. build content
 *   5. content is empty → record the `[no_content]` marker row and return
 *   6. send to the primary chat
 *   7. **only now** record the success run row (onConflict → no-op, so a
 *      racing duplicate send is the lesser harm vs. a permanently-lost digest)
 *   8. (weekly only) Healthchecks.io ping (fire-and-forget)
 *
 * A throw anywhere in 4/6 leaves NO run row → the next cron tick re-attempts.
 */

import { Cron } from 'croner';
import logger from './log.ts';
import { isPublishingEnabled } from './silent-period.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type SendMessage = (
  chatId: number,
  text: string,
  opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
) => Promise<{ message_id: number }>;

/** The window + dedup key resolved from a given moment. */
export interface DigestWindow {
  /** The instant the tick fired (Unix ms). */
  nowMs: number;
  /** Aggregation window start (Unix ms). */
  windowStart: number;
  /** Aggregation window end (Unix ms). */
  windowEnd: number;
  /**
   * The UNIQUE dedup key for this cycle (`week_iso` for weekly,
   * `run_date` for daily). One key ⇒ at most one posted digest.
   */
  dedupKey: string;
}

/** Result of an adapter's builder call, normalised for the shared scaffold. */
export interface DigestContent {
  /** `null` ⇒ nothing to post this cycle (the `[no_content]` marker is used). */
  text: string | null;
  /**
   * Opaque per-digest metadata threaded back into `recordSuccess`
   * (e.g. weekly's `sectionsIncluded`, daily's `includedEventIds`).
   */
  meta: unknown;
}

/**
 * Everything that genuinely differs between the weekly and the daily digest.
 * Each `loop.ts` provides exactly one of these and nothing more.
 */
export interface DigestSpec {
  /** For logs / Healthchecks defaults. e.g. `'digest'`, `'digest-daily'`. */
  module: string;
  /** Croner expression in Europe/Kyiv, e.g. `'0 19 * * 5'`. */
  cron: string;
  /** Resolve the aggregation window + dedup key from the current moment. */
  resolveWindow: () => DigestWindow;
  /** Run the digest-specific builder over the window. */
  build: (db: AnyDb, w: DigestWindow) => Promise<DigestContent>;
  /** Look up an existing run row for `dedupKey`. Truthy ⇒ already handled. */
  findExisting: (db: AnyDb, dedupKey: string) => Promise<unknown>;
  /**
   * Record a "we handled this cycle but posted nothing" row, used for both
   * the Silent-period and the empty-content cases. `marker` is
   * `'[silent-period]'` or `'[no_content]'`. Must be safe under a UNIQUE
   * race (use onConflictDoNothing).
   */
  recordMarker: (
    db: AnyDb,
    w: DigestWindow,
    marker: '[silent-period]' | '[no_content]',
  ) => Promise<void>;
  /**
   * Record the successful-send run row. Called ONLY after a successful send
   * (no-dup-on-crash ordering). Must be safe under a UNIQUE race
   * (onConflictDoNothing): a duplicate post is the lesser harm.
   */
  recordSuccess: (
    db: AnyDb,
    w: DigestWindow,
    sent: { text: string; messageId: number; postedAt: number },
    meta: unknown,
  ) => Promise<void>;
  /** Does the Silent-period gate apply? (weekly: yes, daily: no) */
  silentPeriodGate: boolean;
  /**
   * Healthchecks.io URL to ping (fire-and-forget) after a successful post.
   * Undefined ⇒ no ping (daily). Weekly passes `HEALTHCHECK_DIGEST_URL`.
   */
  healthcheckUrl?: string | undefined;
}

/**
 * The single shared digest tick. Adapters call this with their `DigestSpec`
 * and the runtime deps. Ordering is the documented no-dup-on-crash contract.
 */
export async function runScheduledDigest(
  spec: DigestSpec,
  deps: { db: AnyDb; sendMessage: SendMessage; getPrimaryChatId: () => number },
): Promise<void> {
  const { db, sendMessage, getPrimaryChatId } = deps;
  const { module } = spec;

  try {
    const w = spec.resolveWindow();

    // 2. Silent-period gate (weekly only).
    if (spec.silentPeriodGate && !isPublishingEnabled(new Date(w.nowMs))) {
      await spec.recordMarker(db, w, '[silent-period]');
      logger.info(
        { module, dedup_key: w.dedupKey },
        'Digest skipped — silent period active',
      );
      return;
    }

    // 3. Dedup check — a run row for this key means we already handled it.
    const existing = await spec.findExisting(db, w.dedupKey);
    if (existing) {
      logger.info(
        { module, dedup_key: w.dedupKey },
        'Digest already handled this cycle — skipping (idempotent)',
      );
      return;
    }

    // 4. Build content BEFORE recording any success row — a build/send
    //    failure must not poison the cycle (no-dup-on-crash).
    const { text, meta } = await spec.build(db, w);

    // 5. Empty content → record the [no_content] marker so we don't recompute
    //    every tick, but post nothing.
    if (text === null) {
      await spec.recordMarker(db, w, '[no_content]');
      logger.info(
        { module, dedup_key: w.dedupKey, skipped: 'no_content' },
        'Digest has no content — not posting',
      );
      return;
    }

    // 6. Post to the primary chat. If this throws, the outer catch logs and
    //    the next cron tick re-attempts — no run row exists yet.
    const chatId = getPrimaryChatId();
    const { message_id: messageId } = await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    // 7. Send succeeded — NOW durably record the run (no-dup-on-crash).
    const postedAt = Date.now();
    await spec.recordSuccess(db, w, { text, messageId, postedAt }, meta);

    logger.info(
      { module, dedup_key: w.dedupKey, chat_id: chatId, message_id: messageId },
      'Digest posted successfully',
    );

    // 8. Healthchecks.io ping (fire-and-forget, weekly only).
    if (spec.healthcheckUrl) {
      fetch(spec.healthcheckUrl).catch((err) => {
        logger.warn({ module, err }, 'Healthchecks.io ping failed');
      });
    }
  } catch (err) {
    logger.error({ module, err }, 'Digest tick failed unexpectedly');
  }
}

/**
 * Register the cron job for a `DigestSpec`. Returns a stop function.
 * Croner, Europe/Kyiv, `protect: true` (no overlapping ticks) — identical
 * to the original two loops.
 */
export function startScheduledDigest(
  spec: DigestSpec,
  deps: { db: AnyDb; sendMessage: SendMessage; getPrimaryChatId: () => number },
): () => void {
  const cronJob = new Cron(
    spec.cron,
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runScheduledDigest(spec, deps);
    },
  );

  logger.info(
    { module: spec.module, cron: spec.cron, tz: 'Europe/Kyiv' },
    'Scheduled digest loop started',
  );

  return function stopScheduledDigest() {
    cronJob.stop();
    logger.info({ module: spec.module }, 'Scheduled digest loop stopped');
  };
}
