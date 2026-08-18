/**
 * scheduled-digest.ts — the scaffold behind the scheduled digests. It was
 * extracted (#255) to de-duplicate the weekly and daily loops; today's
 * adapters are `digest/loop.ts` (weekly) and `digest-daily/loop.ts` (daily,
 * removed 2026-08-04 and restored 2026-08-18). The generic `DigestSpec` seam
 * is what makes the idempotency contract below testable in isolation:
 *
 *   - cron registration (Croner, Europe/Kyiv, `protect: true`)
 *   - the idempotency contract (dedup-key lookup + run-row recording)
 *   - the optional Silent-period gate (`lib/silent-period.ts`)
 *   - the optional Healthchecks.io fire-and-forget ping
 *   - the unexpected-error boundary
 *
 * An adapter (see `DigestSpec`) supplies only what is digest-specific: the
 * cron expression, the time window + dedup key, the builder call, the run-row
 * persistence, and two booleans (does the Silent-period gate apply? does the
 * healthcheck ping apply?).
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
import { isAmbiguousSendFailure } from './telegram-send.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type SendMessage = (
  chatId: number,
  text: string,
  opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
) => Promise<{ message_id: number }>;

/**
 * Send a Rich Message (Bot API 10.1+ `sendRichMessage`) to the chat (#309).
 * Resolves to the posted message id on success; REJECTS on any API error so
 * the caller can fall back to the legacy `SendMessage` text path. Injected so
 * this module (and the digest loop) stay free of grammY / the raw-API proxy.
 */
export type SendRichMessage = (
  chatId: number,
  richHtml: string,
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
   * Optional Rich Message HTML (#309/#315). When present AND a `sendRichMessage`
   * is injected, the shared post step tries the rich path first and falls back
   * to the legacy `text` on ANY error. `undefined`/`null` ⇒ legacy text only.
   * The recorded `posted_text` is always the legacy `text` (byte-compatible).
   * Daily (#315) sets this; the shared scaffold ignores it when unset so callers
   * wired before #315 are unchanged.
   */
  richHtml?: string | null;
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
   * Optional weekly-only publish override (issue #227 two-phase digest).
   *
   * When set, `runScheduledDigest` runs ONLY the unexpected-error boundary
   * and the Silent-period gate, then hands the entire dedup/build/post
   * decision to this function. The weekly digest needs branching the shared
   * scaffold deliberately does not model (prepared-row → post saved text +
   * best-effort photo reply; no row → fresh build text-only). Daily NEVER
   * sets this, so its observable behaviour is byte-for-byte unchanged: it
   * still runs the documented no-dup-on-crash path (steps 3–8).
   *
   * The override is responsible for its own idempotency. It must preserve
   * the #255 ordering: the published/posted-state row is written
   * immediately after the text send succeeds, BEFORE the best-effort image.
   *
   * If the override returns normally, the scaffold fires the Healthchecks
   * ping just like step 8 of the regular flow — successful override return
   * is the same liveness signal as a successful post. A throw out of the
   * override is caught by the unexpected-error boundary and skips the ping.
   */
  publishOverride?: (
    db: AnyDb,
    w: DigestWindow,
    deps: {
      sendMessage: SendMessage;
      sendRichMessage: SendRichMessage;
      getPrimaryChatId: () => number;
    },
  ) => Promise<void>;
  /**
   * Healthchecks.io URL to ping (fire-and-forget) after a successful post.
   * Undefined ⇒ no ping (daily). Weekly passes `HEALTHCHECK_DIGEST_URL`.
   */
  healthcheckUrl?: string | undefined;
}

/**
 * Post the digest text to `chatId`, preferring the Rich Message path (#315)
 * when a `richHtml` was produced AND a `sendRichMessage` is injected, falling
 * back to the legacy `sendMessage(text, HTML)` on ANY rich-send error (or when
 * no rich content / sender is available). Returns the posted message id.
 *
 * A rich-send throw is swallowed here (logged) so the digest still goes out via
 * the legacy path — but ONLY when Telegram definitively refused it. A rich send
 * whose answer was lost may already be in the chat, so it propagates instead of
 * being followed by a second copy in plain text. A legacy-send throw propagates
 * to the caller's no-dup-on-crash boundary.
 */
async function postDigestText(
  module: string,
  dedupKey: string,
  chatId: number,
  richHtml: string | null | undefined,
  legacyText: string,
  deps: { sendMessage: SendMessage; sendRichMessage?: SendRichMessage | undefined },
): Promise<number> {
  if (richHtml != null && deps.sendRichMessage) {
    try {
      const { message_id } = await deps.sendRichMessage(chatId, richHtml);
      logger.info(
        { module, dedup_key: dedupKey, message_id, path: 'rich' },
        'Digest posted via sendRichMessage',
      );
      return message_id;
    } catch (err) {
      // A rich send we KNOW Telegram refused (a 4xx on the html, or the "not
      // wired" stub) can safely be re-sent as legacy text. One that merely lost
      // its answer cannot: the rich message may already be in the chat, and the
      // fallback would put the same digest there a second time.
      if (isAmbiguousSendFailure(err)) {
        logger.error(
          { module, dedup_key: dedupKey, err },
          'sendRichMessage got no answer — the digest MAY be posted; not falling back',
        );
        throw err;
      }
      logger.warn(
        { module, dedup_key: dedupKey, err },
        'sendRichMessage failed, falling back to legacy text',
      );
    }
  }
  const { message_id } = await deps.sendMessage(chatId, legacyText, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  logger.info(
    { module, dedup_key: dedupKey, message_id, path: 'legacy', rich_null: richHtml == null },
    'Digest posted via legacy sendMessage',
  );
  return message_id;
}

/**
 * The single shared digest tick. Adapters call this with their `DigestSpec`
 * and the runtime deps. Ordering is the documented no-dup-on-crash contract.
 */
export async function runScheduledDigest(
  spec: DigestSpec,
  deps: {
    db: AnyDb;
    sendMessage: SendMessage;
    /** Optional rich send (#309). Only the weekly two-phase override uses it. */
    sendRichMessage?: SendRichMessage | undefined;
    getPrimaryChatId: () => number;
  },
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

    // 2b. Weekly two-phase publish override (#227). Daily never sets this,
    //     so daily continues through the unchanged steps 3–8 below.
    if (spec.publishOverride) {
      // A no-op rich sender (always rejects) when none is injected, so the
      // override transparently falls back to the legacy text path — preserves
      // behaviour for callers wired before #309.
      const sendRichMessage: SendRichMessage =
        deps.sendRichMessage ??
        (() => Promise.reject(new Error('sendRichMessage not wired')));
      await spec.publishOverride(db, w, { sendMessage, sendRichMessage, getPrimaryChatId });
      // Healthchecks.io ping (fire-and-forget). Mirrors step 8 for the
      // regular flow — the override is the publish path when two-phase is
      // wired (#227), and its successful return is the same liveness signal
      // as a successful post on the non-override path. Without this the
      // weekly check went DOWN every Friday (issue #290).
      if (spec.healthcheckUrl) {
        fetch(spec.healthcheckUrl).catch((err) => {
          logger.warn({ module, err }, 'Healthchecks.io ping failed');
        });
      }
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
    const { text, richHtml, meta } = await spec.build(db, w);

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
    //
    //    Rich-first-fallback (#315): when the build produced a `richHtml` AND a
    //    `sendRichMessage` is injected, try the Rich Message path first and fall
    //    back to the legacy `sendMessage(text)` on ANY rich-send error. The
    //    recorded `posted_text` stays the legacy `text` either way, so the
    //    run-row semantics are byte-compatible with the pre-#315 behaviour.
    //    When no rich content / no rich sender, this is exactly the old path.
    const chatId = getPrimaryChatId();
    const messageId = await postDigestText(
      module,
      w.dedupKey,
      chatId,
      richHtml,
      text,
      { sendMessage, sendRichMessage: deps.sendRichMessage },
    );

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
  deps: {
    db: AnyDb;
    sendMessage: SendMessage;
    sendRichMessage?: SendRichMessage | undefined;
    getPrimaryChatId: () => number;
  },
): () => void {
  // The callback RETURNS the promise so croner awaits it — `protect: true`
  // skips an overlapping tick only while the previous one is still running, and
  // it decides that by awaiting the callback's return value. With the promise
  // discarded, croner cleared its blocking flag on the next microtask and the
  // guard was decorative.
  const cronJob = new Cron(
    spec.cron,
    { timezone: 'Europe/Kyiv', protect: true },
    () => runScheduledDigest(spec, deps),
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
