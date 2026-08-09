/**
 * loop.ts — Publisher loop that reads pending detected_events and posts them.
 *
 * Runs every minute via croner. On each tick:
 * 1. If EVENTS_PUBLISHING_ENABLED_AFTER is in the future → mark all pending as 'silent'.
 * 2. Fetch the oldest pending event, then EVERY pending event of the same type
 *    for the same match (see "Per-match uniqueness" below).
 * 3. Apply the opt-out check via decide() to each of them.
 * 4. Post ONE message covering them all, or update statuses.
 *
 * ## Per-match uniqueness
 *
 * A realtime event is about a match, so the group gets at most ONE message per
 * (match, event type) — never one per community member who happened to trigger
 * it. Detection cannot enforce this: each player is scanned separately, so a
 * match with three community players yields three `detected_events` rows
 * (the unique index is `(match_id, event_type, riot_puuid)`), and the two
 * detectors that do guard themselves with `hasMatchEvent` still race when two
 * scans overlap. Both failures were live — «💪 Поводил(ла) по губам» and
 * «👏 Мы вами гордимся» each posted twice for one match (owner, 2026-08-09).
 *
 * So the loop enforces it at publish time, where the whole picture is visible:
 *   - an event waits {@link PUBLISH_GRACE_MS} before it is eligible, so the
 *     scan sweep that produces its siblings has time to finish;
 *   - all pending siblings then collapse into one message
 *     (`renderGroupedTemplate` lists every player) and are marked posted
 *     together;
 *   - a sibling that still arrives AFTER the message went out finds the match
 *     already posted and is marked 'silent'.
 * This holds regardless of how the rows were produced, so detectors stay pure.
 */

import { Cron } from 'croner';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { decide } from './decide.ts';
import { renderGroupedTemplate, type EventSubject, type TemplateMatch } from './templates.ts';
import { resolveTemplateMatch } from './match-info.ts';
import { renderRichEvent, isTrioRichEvent } from './rich-templates.ts';
import { isRealtimeEvent, type EventType } from './types.ts';
import logger from '../lib/log.ts';
import { isPublishingEnabled } from '../lib/silent-period.ts';
import { sendWithRetryFn, isAmbiguousSendFailure } from '../lib/telegram-send.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type { InjectedSendFn } from '../lib/telegram-send.ts';

export interface KyivTime {
  /** Current hour in Kyiv (0–23). */
  hour: number;
  /** Today's start in UTC ms (midnight Europe/Kyiv). */
  today_start_ms: number;
}

export interface PublisherLoopDeps {
  db: AnyDb;
  /** Send a message to a chat. Should use safeSendMessage. */
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { parse_mode?: string; disable_web_page_preview?: boolean },
  ) => Promise<{ message_id: number }>;
  /**
   * Send a Rich Message (HTML) to a chat — used for the #315 "trio" events
   * (giant_slayer / match_comeback / community_clash), which render as
   * full-roster tables. Optional: when absent (or on ANY error), the loop falls
   * back to the legacy plain-text `sendMessage` path. Destination/dedup/retry
   * semantics are identical to the plain path.
   */
  sendRichMessage?: (chatId: number, html: string) => Promise<{ message_id: number }>;
  /** Get the primary chat ID to post to. Defaults to TELEGRAM_PRIMARY_CHAT_ID env var. */
  getPrimaryChatId?: () => number;
  /** Injectable Kyiv time for testing (kept for API compatibility). */
  getNowKyiv?: () => KyivTime;
  /** Override cron expression for tests. */
  intervalCron?: string;
  /**
   * How long an event waits before it may be published. Defaults to
   * {@link PUBLISH_GRACE_MS}; tests pass 0. See the module header — this is
   * what gives a match's siblings time to be detected so they can share one
   * message instead of the later ones being suppressed as duplicates.
   */
  publishGraceMs?: number;
}

/**
 * How long a detected event waits before the publisher will post it.
 *
 * Community players are scanned one at a time (`scanner/loop.ts` sleeps between
 * users, plus Henrik latency), so the events for one match land spread across a
 * whole scan sweep — a couple of minutes for a ~30-person group. The publisher
 * ticks every minute, so without a wait the first player's event gets posted
 * alone and everyone scanned afterwards is suppressed as a duplicate: no double
 * post, but their names never reach the chat. Five minutes comfortably covers a
 * sweep, and realtime events are already up to 15 minutes old (the scan
 * interval) by the time they exist, so the added delay is not noticeable.
 */
export const PUBLISH_GRACE_MS = 5 * 60_000;

export function startPublisherLoop(deps: PublisherLoopDeps): () => void {
  const { db } = deps;
  const cronExpr = deps.intervalCron ?? '* * * * *';

  const getPrimaryChatId = deps.getPrimaryChatId
    ?? (() => Number(process.env['TELEGRAM_PRIMARY_CHAT_ID'] ?? '0'));

  async function runTick(): Promise<void> {
    try {
      const nowMs = Date.now();

      // Step 1: Check if publishing period has started
      if (!isPublishingEnabled(new Date(nowMs))) {
        // Mass-update all pending to silent
        const result = await db
          .update(detectedEvents)
          .set({ status: 'silent' })
          .where(eq(detectedEvents.status, 'pending'));

        if (result.changes > 0) {
          logger.info(
            { module: 'publisher', changes: result.changes },
            'Publishing not yet enabled — marked pending events as silent',
          );
        }
        return;
      }

      // Step 2: Fetch the oldest pending event that has served its grace period
      // (young events are left alone so their match's siblings can arrive).
      const graceMs = deps.publishGraceMs ?? PUBLISH_GRACE_MS;
      const [pendingEvent] = await db
        .select()
        .from(detectedEvents)
        .where(
          and(
            eq(detectedEvents.status, 'pending'),
            lte(detectedEvents.detected_at, nowMs - graceMs),
          ),
        )
        .orderBy(detectedEvents.detected_at)
        .limit(1);

      if (!pendingEvent) {
        return; // Nothing to process
      }

      const eventId = pendingEvent.id as number;
      const eventType = pendingEvent.event_type as EventType;
      const matchId = (pendingEvent.match_id as string | null) ?? null;

      /** Apply one status patch to a batch of event rows. */
      const patchEvents = async (
        ids: number[],
        values: Record<string, unknown>,
      ): Promise<void> => {
        if (ids.length === 0) return;
        await db.update(detectedEvents).set(values).where(inArray(detectedEvents.id, ids));
      };

      // Step 2b: Defense-in-depth — non-realtime events (daily or weekly) must
      // never reach the realtime publisher. If one is found, it's a detector
      // bug. Mark silent and skip.
      if (!isRealtimeEvent(eventType)) {
        logger.warn(
          { module: 'publisher', event_id: eventId, event_type: eventType },
          'Non-realtime event landed in realtime queue — skipping',
        );
        await patchEvents([eventId], { status: 'silent' });
        return;
      }

      // Step 2c: Every pending event of this type for this match — they become
      // ONE message. Ordered oldest-first so the players are named in the order
      // their scans landed (stable across ticks). An event with no match id
      // stands alone.
      const siblings: Array<Record<string, unknown>> = matchId
        ? await db
            .select()
            .from(detectedEvents)
            .where(
              and(
                eq(detectedEvents.status, 'pending'),
                eq(detectedEvents.event_type, eventType),
                eq(detectedEvents.match_id, matchId),
              ),
            )
            .orderBy(detectedEvents.detected_at, detectedEvents.id)
        : [pendingEvent];

      // Step 2d: …unless a message for this match+type already went out. That
      // happens when one player's scan lands after the tick that published the
      // others, and it is exactly the "posted twice" the group complained
      // about. Suppress the stragglers rather than repeat the post.
      if (matchId) {
        const [alreadyPosted] = await db
          .select({ id: detectedEvents.id })
          .from(detectedEvents)
          .where(
            and(
              eq(detectedEvents.event_type, eventType),
              eq(detectedEvents.match_id, matchId),
              eq(detectedEvents.status, 'posted'),
            ),
          )
          .limit(1);

        if (alreadyPosted) {
          const dupeIds = siblings.map((s) => s.id as number);
          await patchEvents(dupeIds, { status: 'silent' });
          logger.info(
            {
              module: 'publisher',
              event_type: eventType,
              match_id: matchId,
              suppressed: dupeIds.length,
              posted_event_id: alreadyPosted.id,
            },
            'Match already posted for this event type — suppressing duplicate events',
          );
          return;
        }
      }

      // Step 3–5: resolve each player, apply the opt-out decision, and collect
      // the ones that get to be in the message. Everything else is closed out
      // with its own status.
      const subjects: EventSubject[] = [];
      const postableIds: number[] = [];
      const heroPuuids: string[] = [];
      const skippedByStatus = new Map<string, number[]>();
      let priorAttempts = 0;
      let primaryPayload: Record<string, unknown> = {};
      let primaryMatch: TemplateMatch | undefined;

      const skip = (status: string, id: number): void => {
        const ids = skippedByStatus.get(status) ?? [];
        ids.push(id);
        skippedByStatus.set(status, ids);
      };

      for (const ev of siblings) {
        const evId = ev.id as number;
        const puuid = ev.riot_puuid as string;

        const [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.riot_puuid, puuid))
          .limit(1);

        if (!userRow) {
          logger.warn({ module: 'publisher', event_id: evId, puuid }, 'No user found for event — skipping');
          skip('silent', evId);
          continue;
        }

        const telegramId = userRow.telegram_id as number;

        const [optOutRow] = await db
          .select()
          .from(optOuts)
          .where(eq(optOuts.telegram_id, telegramId))
          .limit(1);

        const is_opted_out = optOutRow?.chat_realtime_disabled === 1;

        const decision = decide({
          event: { event_type: eventType, riot_puuid: puuid },
          is_opted_out,
          events_publishing_enabled: true, // already checked above
        });

        logger.info(
          {
            module: 'publisher',
            event_id: evId,
            event_type: eventType,
            decision,
            is_opted_out,
          },
          'Publisher decision',
        );

        if (decision !== 'post') {
          skip(decision, evId);
          continue;
        }

        // Parse payload first — the match-info resolver needs it
        // (real_match_id for kills-per-weapon, victims for teamkill).
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.payload_json as string) as Record<string, unknown>;
        } catch {
          logger.warn({ module: 'publisher', event_id: evId }, 'Failed to parse payload_json');
        }

        // Resolve the per-match template context (map / match_id / this
        // player's agent + per-match rank / teamkill victims from the roster)
        // via the SHARED resolver — the same function backs the
        // /test_runtime_events replay, so preview === production (#315).
        // Per PLAYER, not per message: agent, rank and victims all differ.
        const matchInfo = await resolveTemplateMatch(
          db,
          eventType,
          ev.match_id as string,
          puuid,
          payload,
        );

        subjects.push({
          payload,
          user: {
            riot_name: userRow.riot_name as string ?? '',
            riot_tag: userRow.riot_tag as string ?? '',
            telegram_id: telegramId,
          },
          ...(matchInfo ? { match: matchInfo } : {}),
        });
        postableIds.push(evId);
        heroPuuids.push(puuid);
        priorAttempts = Math.max(priorAttempts, Number(ev.failed_attempts ?? 0));
        if (subjects.length === 1) {
          primaryPayload = payload;
          primaryMatch = matchInfo;
        }
      }

      // Close out everyone who isn't in the message before anything can throw.
      for (const [status, ids] of skippedByStatus) {
        await patchEvents(ids, { status });
      }

      if (subjects.length === 0) {
        return; // nobody left to post about
      }

      const chatId = getPrimaryChatId();
      if (!chatId) {
        logger.warn({ module: 'publisher' }, 'No primary chat ID — cannot post');
        return;
      }

      // Claim the group BEFORE sending. Marking rows posted afterwards meant a
      // crash — or a swallowed UPDATE — left them pending, and the next tick
      // (this loop runs every minute) sent the identical message again. The
      // conditional `status='pending'` also makes the claim the one place two
      // overlapping ticks can race, and only one of them can win it.
      const claim = await db
        .update(detectedEvents)
        .set({ status: 'posted', posted_at: nowMs, posted_message_id: null })
        .where(and(inArray(detectedEvents.id, postableIds), eq(detectedEvents.status, 'pending')));

      if (claim.changes !== postableIds.length) {
        // Somebody else already claimed part of this group. Whatever they are
        // doing, adding a second message to it is the failure mode we are
        // here to prevent — the rows we did claim stay closed out.
        logger.warn(
          {
            module: 'publisher', event_ids: postableIds, event_type: eventType,
            match_id: matchId, claimed: claim.changes,
          },
          'Could not claim the whole group — another tick is handling this match, standing down',
        );
        return;
      }

      // ONE message for the whole match: title once, every player named.
      const text = renderGroupedTemplate(eventType, subjects);

      // Send message with retry on 429 + Telegram 5xx + transient network errors.
      // Retry policy is owned by telegram-send.ts (sendWithRetryFn).
      // A purely-durable failure (4xx other than 429: "chat not found", "message
      // too long", "chat archived") cannot succeed by retrying — to avoid
      // head-of-line blocking the whole queue, we increment failed_attempts and
      // park the event in status='failed' after MAX_FAILED_ATTEMPTS.
      let messageId: number | undefined;
      let lastErr: unknown;
      // Set when the rich send's outcome is unknown: the roster table may
      // already be in the chat, so the plain fallback below must NOT run.
      let richOutcomeUnknown = false;

      // #315 "trio" events (giant_slayer / match_comeback / community_clash)
      // render as full-roster rich tables. Try the rich path FIRST; fall back
      // to the legacy plain template when the rich attempt definitively left
      // the chat empty (missing dep, incomplete roster → null, render throw, a
      // 4xx on the html). A rich send Telegram never ANSWERED is different:
      // the table may already be in the chat, so falling back would post the
      // same event twice — see `richOutcomeUnknown`.
      if (isTrioRichEvent(eventType) && deps.sendRichMessage) {
        const richSend = deps.sendRichMessage;
        try {
          const richHtml = await renderRichEvent(db, eventType, primaryPayload, {
            ...(primaryMatch?.match_id ? { match_id: primaryMatch.match_id } : {}),
            ...(primaryMatch?.map ? { map: primaryMatch.map } : {}),
            // Subjects of the event (used by giant_slayer to name them under
            // the title) — every community player this event fired for.
            ...(heroPuuids.length > 0 ? { heroPuuids } : {}),
          });
          if (richHtml) {
            const result = await sendWithRetryFn(
              (chat, html) => richSend(chat, html),
              chatId,
              richHtml,
              undefined,
              { module: 'publisher', event_id: eventId, path: 'rich' },
            );
            messageId = result.message_id;
          }
        } catch (err: unknown) {
          // A rich send Telegram never answered is not a reason to fall back:
          // the table may already be in the chat, and posting the plain
          // template on top of it is the double post this loop exists to
          // prevent (owner, 2026-08-09). Everything else caught here — a
          // render throw, a missing dep, a 4xx on the rich html — genuinely
          // left the chat empty, so the legacy template still goes out.
          if (isAmbiguousSendFailure(err)) {
            richOutcomeUnknown = true;
            lastErr = err;
          } else {
            logger.warn(
              { module: 'publisher', event_id: eventId, event_type: eventType, err },
              'Rich send failed — falling back to legacy plain template',
            );
            // messageId stays undefined ⇒ the plain path below runs.
          }
        }
      }

      if (messageId === undefined && !richOutcomeUnknown) {
        try {
          const result = await sendWithRetryFn(
            deps.sendMessage,
            chatId,
            text,
            { parse_mode: 'HTML', disable_web_page_preview: true },
            { module: 'publisher', event_id: eventId },
          );
          messageId = result.message_id;
        } catch (err: unknown) {
          lastErr = err;
        }
      }

      if (lastErr !== undefined) {
        const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        const newAttempts = priorAttempts + 1;

        // Telegram never answered, so the message may already be in the group.
        // Rolling the claim back reposts it on the next tick, and parking the
        // rows outside 'posted' is no better — the match-already-posted guard
        // in step 2d only suppresses siblings against a 'posted' row, so the
        // next player scanned for this match would post it all over again. So
        // the group stays closed out as posted with NO message id: an event
        // that silently goes missing is a far smaller harm than the same one
        // posted twice, which is exactly what the group complained about
        // (owner, 2026-08-09). `last_error` records why the id is missing.
        if (isAmbiguousSendFailure(lastErr)) {
          await patchEvents(postableIds, {
            last_error: `send outcome unknown: ${errMsg}`.slice(0, 500),
          });
          logger.error(
            {
              module: 'publisher', event_ids: postableIds, event_type: eventType,
              match_id: matchId, attempts: newAttempts, err: errMsg,
            },
            'Send outcome unknown — leaving the group closed out so it cannot be posted twice',
          );
          return;
        }

        // Telegram refused it, so nothing was posted: release the claim so the
        // next tick can try again. After MAX_FAILED_ATTEMPTS a row is parked
        // as 'failed' so the queue moves past poison events instead of
        // blocking forever. The counter is per ROW — a fresh sibling must not
        // inherit an older row's strikes and be parked on its first attempt.
        const MAX_FAILED_ATTEMPTS = 3;
        await patchEvents(postableIds, {
          status: 'pending',
          posted_at: null,
          failed_attempts: sql`${detectedEvents.failed_attempts} + 1`,
          last_error: errMsg.slice(0, 500),
        });
        const parked = await db
          .update(detectedEvents)
          .set({ status: 'failed' })
          .where(and(
            inArray(detectedEvents.id, postableIds),
            gte(detectedEvents.failed_attempts, MAX_FAILED_ATTEMPTS),
          ));
        if (parked.changes > 0) {
          logger.error(
            { module: 'publisher', event_ids: postableIds, parked: parked.changes, err: errMsg },
            'Events marked as failed after max attempts — unblocking queue',
          );
        } else {
          logger.warn(
            { module: 'publisher', event_ids: postableIds, attempts: newAttempts, err: errMsg },
            'Send refused — back to pending, will retry next tick',
          );
        }
        return;
      }

      // Success — the claim already marked them posted; record the message id.
      const postedAt = nowMs;
      await patchEvents(postableIds, {
        posted_message_id: messageId ?? null,
      });

      logger.info(
        {
          module: 'publisher',
          event_ids: postableIds,
          event_type: eventType,
          match_id: matchId,
          players: subjects.length,
          chat_id: chatId,
          message_id: messageId,
        },
        'Event posted successfully',
      );
    } catch (err) {
      logger.error({ module: 'publisher', err }, 'Publisher tick failed unexpectedly');
    }
  }

  // The callback RETURNS the promise so croner awaits it — `protect: true` only
  // skips an overlapping tick while the previous one is still running, and it
  // decides that by awaiting the callback's return value. With the promise
  // discarded, croner cleared its blocking flag on the next microtask and a
  // slow tick (a 429 `retry_after` sleeps up to a minute inside the send) could
  // be re-entered by the next tick — which would re-select the same still-
  // pending rows and post the message twice.
  const cronJob = new Cron(cronExpr, { protect: true }, () => runTick());

  logger.info({ module: 'publisher', cron: cronExpr }, 'Publisher loop started');

  return function stopPublisherLoop() {
    cronJob.stop();
    logger.info({ module: 'publisher' }, 'Publisher loop stopped');
  };
}
