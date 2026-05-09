/**
 * loop.ts — Publisher loop that reads pending detected_events and posts them.
 *
 * Runs every minute via croner. On each tick:
 * 1. Compute current Kyiv time and today's start in ms.
 * 2. If EVENTS_PUBLISHING_ENABLED_AFTER is in the future → mark all pending as 'silent'.
 * 3. If before 12:00 Kyiv → defer (skip this tick).
 * 4. Fetch the oldest pending event.
 * 5. Apply anti-spam quotas via decide().
 * 6. Either post, update status, or defer.
 *
 * Kyiv timezone: Europe/Kyiv (UTC+2 in winter, UTC+3 in summer / DST).
 * We use Intl.DateTimeFormat formatToParts to robustly extract date components,
 * then reconstruct today's midnight in Kyiv by parsing a local ISO string.
 *
 * Approach for today_start_ms:
 *   - Format "now" in Europe/Kyiv → extract year/month/day parts.
 *   - Build a string like "YYYY-MM-DDT00:00:00" and parse it in Kyiv timezone.
 *   - We use Intl to get the UTC offset at midnight so we can do Date.parse correctly.
 *   - Simpler: use `new Date(Date.UTC(y, m-1, d))` then subtract the Kyiv offset at midnight.
 *   - Simplest robust approach: format "YYYY-MM-DD 00:00:00" then use another Intl call
 *     to compute what UTC ms that corresponds to. We pick the simplest: format date string
 *     as "YYYY-MM-DDTHH:MM:SS" in Kyiv, parse back. Since we can't directly, we use:
 *     compute now_kyiv_parts → build `YYYY-MM-DDT00:00:00` → get UTC ms via a binary
 *     approach: find UTC ms where Kyiv date matches. But that's overengineered.
 *   - Practical: Kyiv is UTC+2 or UTC+3. We format "now" to get Kyiv date string,
 *     then try midnight UTC+2 and UTC+3, pick whichever gives matching Kyiv date.
 *     Actually simplest correct approach: use date-fns-tz (not a dep) or the manual calc:
 *     build ISO string "YYYY-MM-DDT00:00:00+03:00" — this approximates (may be off by 1h
 *     near DST boundaries). For our use-case (determining "today's posts") this is fine.
 *     The spec itself suggests: `Date.parse(date_str + 'T00:00:00+03:00')` noting "Kyiv is UTC+3".
 *   - We follow the spec suggestion with a note: may be off by 1h near spring/autumn DST.
 *     For a gaming community bot, this is acceptable.
 */

import { Cron } from 'croner';
import { eq, and, gte, inArray, sql } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { decide, ANTISTAT_TYPES } from './decide.ts';
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

/**
 * Compute current Kyiv time info.
 *
 * Uses Intl.DateTimeFormat to extract date parts in Europe/Kyiv, then
 * constructs today's midnight as `YYYY-MM-DDT00:00:00+03:00` per spec.
 * (May be ±1h near DST boundaries — acceptable for anti-spam use case.)
 */
export function getKyivTime(nowMs?: number): KyivTime {
  const now = nowMs ?? Date.now();

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = parseInt(get('hour'), 10);

  // Build today_start_ms as midnight Kyiv (using UTC+3 approximation per spec)
  const dateStr = `${year}-${month}-${day}T00:00:00+03:00`;
  const today_start_ms = Date.parse(dateStr);

  return { hour, today_start_ms };
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
  /** Injectable Kyiv time for testing. */
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

  const getNowKyiv = deps.getNowKyiv ?? getKyivTime;

  async function runTick(): Promise<void> {
    try {
      const nowMs = Date.now();
      const kyivTime = getNowKyiv();
      const { hour, today_start_ms } = kyivTime;

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

      // Step 2: Quiet hours check — before 12:00 Kyiv
      if (hour < 12) {
        logger.debug({ module: 'publisher', hour }, 'Quiet hours — skipping publisher tick');
        return;
      }

      // Step 3: Fetch the oldest pending event
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

      // Step 4: Fetch user info
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

      // Step 5: Check opt-out
      const [optOutRow] = await db
        .select()
        .from(optOuts)
        .where(eq(optOuts.telegram_id, telegramId))
        .limit(1);

      const is_opted_out = optOutRow?.chat_realtime_disabled === 1;

      // Step 6: Compute counters
      const [chatCountRow] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(detectedEvents)
        .where(
          and(
            eq(detectedEvents.status, 'posted'),
            gte(detectedEvents.posted_at, today_start_ms),
          ),
        );

      const [userCountRow] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(detectedEvents)
        .where(
          and(
            eq(detectedEvents.status, 'posted'),
            gte(detectedEvents.posted_at, today_start_ms),
            eq(detectedEvents.riot_puuid, puuid),
          ),
        );

      const antistatTypesList = [...ANTISTAT_TYPES] as string[];
      const [antistatCountRow] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(detectedEvents)
        .where(
          and(
            eq(detectedEvents.status, 'posted'),
            gte(detectedEvents.posted_at, today_start_ms),
            inArray(detectedEvents.event_type, antistatTypesList),
          ),
        );

      const today_chat_count = Number(chatCountRow?.count ?? 0);
      const today_user_count = Number(userCountRow?.count ?? 0);
      const today_antistat_count = Number(antistatCountRow?.count ?? 0);

      // Step 7: Decide
      const decision = decide({
        event: { event_type: eventType, riot_puuid: puuid },
        today_chat_count,
        today_user_count,
        today_antistat_count,
        is_opted_out,
        events_publishing_enabled: true, // already checked above
        in_quiet_hours: false,           // already checked above
      });

      logger.info(
        {
          module: 'publisher',
          event_id: eventId,
          event_type: eventType,
          decision,
          today_chat_count,
          today_user_count,
          today_antistat_count,
          is_opted_out,
        },
        'Publisher decision',
      );

      // Step 8: Act on decision
      if (decision === 'defer') {
        // Don't update status — try again next tick
        return;
      }

      if (decision === 'silent' || decision === 'opted-out' || decision === 'digest-only') {
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
