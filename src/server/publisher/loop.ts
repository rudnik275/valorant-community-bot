/**
 * loop.ts — Publisher loop that reads pending detected_events and posts them.
 *
 * Runs every minute via croner. On each tick:
 * 1. If EVENTS_PUBLISHING_ENABLED_AFTER is in the future → mark all pending as 'silent'.
 * 2. Fetch the oldest pending event.
 * 3. Apply opt-out check via decide().
 * 4. Either post or update status.
 */

import { Cron } from 'croner';
import { eq, and } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { decide } from './decide.ts';
import { renderTemplate } from './templates.ts';
import type { EventType } from './types.ts';
import logger from '../lib/log.ts';
import { isPublishingEnabled } from '../lib/silent-period.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

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
  /** Get the primary chat ID to post to. Defaults to TELEGRAM_PRIMARY_CHAT_ID env var. */
  getPrimaryChatId?: () => number;
  /** Injectable Kyiv time for testing (kept for API compatibility). */
  getNowKyiv?: () => KyivTime;
  /** Override cron expression for tests. */
  intervalCron?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      // Step 2: Fetch the oldest pending event
      const [pendingEvent] = await db
        .select()
        .from(detectedEvents)
        .where(eq(detectedEvents.status, 'pending'))
        .orderBy(detectedEvents.detected_at)
        .limit(1);

      if (!pendingEvent) {
        return; // Nothing to process
      }

      const eventId = pendingEvent.id as number;
      const eventType = pendingEvent.event_type as EventType;
      const puuid = pendingEvent.riot_puuid as string;

      // Step 3: Fetch user info
      const [userRow] = await db
        .select()
        .from(users)
        .where(eq(users.riot_puuid, puuid))
        .limit(1);

      if (!userRow) {
        logger.warn({ module: 'publisher', event_id: eventId, puuid }, 'No user found for event — skipping');
        await db
          .update(detectedEvents)
          .set({ status: 'silent' })
          .where(eq(detectedEvents.id, eventId));
        return;
      }

      const telegramId = userRow.telegram_id as number;

      // Step 4: Check opt-out
      const [optOutRow] = await db
        .select()
        .from(optOuts)
        .where(eq(optOuts.telegram_id, telegramId))
        .limit(1);

      const is_opted_out = optOutRow?.chat_realtime_disabled === 1;

      // Step 5: Decide
      const decision = decide({
        event: { event_type: eventType, riot_puuid: puuid },
        is_opted_out,
        events_publishing_enabled: true, // already checked above
      });

      logger.info(
        {
          module: 'publisher',
          event_id: eventId,
          event_type: eventType,
          decision,
          is_opted_out,
        },
        'Publisher decision',
      );

      // Step 6: Act on decision
      if (decision === 'silent' || decision === 'opted-out') {
        await db
          .update(detectedEvents)
          .set({ status: decision })
          .where(eq(detectedEvents.id, eventId));
        return;
      }

      // decision === 'post'
      const chatId = getPrimaryChatId();
      if (!chatId) {
        logger.warn({ module: 'publisher' }, 'No primary chat ID — cannot post');
        return;
      }

      // Fetch match for map info
      const matchId = pendingEvent.match_id as string;
      const [matchRow] = await db
        .select({ map: matchRecords.map })
        .from(matchRecords)
        .where(
          and(
            eq(matchRecords.match_id, matchId),
            eq(matchRecords.riot_puuid, puuid),
          ),
        )
        .limit(1);

      const matchInfo: { map?: string } | undefined = matchRow
        ? (matchRow.map ? { map: matchRow.map as string } : {})
        : undefined;

      // Parse payload
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(pendingEvent.payload_json as string) as Record<string, unknown>;
      } catch {
        logger.warn({ module: 'publisher', event_id: eventId }, 'Failed to parse payload_json');
      }

      const text = renderTemplate(
        eventType,
        payload,
        {
          riot_name: userRow.riot_name as string ?? '',
          riot_tag: userRow.riot_tag as string ?? '',
          telegram_id: telegramId,
        },
        matchInfo,
      );

      // Send message with 429 retry
      let messageId: number | undefined;
      let lastErr: unknown;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await deps.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          messageId = result.message_id;
          lastErr = undefined;
          break;
        } catch (err: unknown) {
          lastErr = err;

          // Check for 429 rate limit
          const is429 = err instanceof Error &&
            (err.message.includes('429') || ('error_code' in (err as object) && (err as { error_code?: number }).error_code === 429));

          if (is429 && attempt === 0) {
            // Extract retry_after from Telegram error if available
            const retryAfter = ('parameters' in (err as object)
              ? ((err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5)
              : 5);
            logger.warn(
              { module: 'publisher', event_id: eventId, retry_after: retryAfter },
              'Telegram 429 — retrying after delay',
            );
            await sleep(retryAfter * 1000);
            continue;
          }

          // Non-429 error on any attempt: log and leave as pending
          break;
        }
      }

      if (lastErr !== undefined) {
        logger.error(
          { module: 'publisher', event_id: eventId, err: lastErr },
          'Failed to send message — leaving event as pending for next tick',
        );
        return;
      }

      // Success — update event
      const postedAt = Date.now();
      await db
        .update(detectedEvents)
        .set({
          status: 'posted',
          posted_at: postedAt,
          posted_message_id: messageId ?? null,
        })
        .where(eq(detectedEvents.id, eventId));

      logger.info(
        {
          module: 'publisher',
          event_id: eventId,
          event_type: eventType,
          decision,
          chat_id: chatId,
          message_id: messageId,
        },
        'Event posted successfully',
      );
    } catch (err) {
      logger.error({ module: 'publisher', err }, 'Publisher tick failed unexpectedly');
    }
  }

  const cronJob = new Cron(cronExpr, { protect: true }, () => {
    void runTick();
  });

  logger.info({ module: 'publisher', cron: cronExpr }, 'Publisher loop started');

  return function stopPublisherLoop() {
    cronJob.stop();
    logger.info({ module: 'publisher' }, 'Publisher loop stopped');
  };
}
