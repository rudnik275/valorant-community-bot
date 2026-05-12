/**
 * test-commands.ts — Admin-only preview commands for the bot.
 *
 *   /test_digest [N]          — preview the weekly digest for the last N days
 *                               (default 7). Sent only to the owner's DM.
 *   /test_runtime_events [N]  — replay each realtime event from the last N days
 *                               (default 2) as separate messages to the owner's
 *                               DM. Pure read from detected_events — no
 *                               detector re-runs, no DB writes.
 *
 * Both commands are gated by `TELEGRAM_OWNER_ID`. Non-owners are silently
 * ignored (the bot does not reply at all).
 *
 * Why bot.api.sendMessage directly (bypassing safe-telegram.ts):
 *   The safe-telegram wrappers exist to prevent leaks into unauthorised group
 *   chats (where community data could escape). The risk model does not apply
 *   here: target = ctx.from.id = the owner who issued the command. isOwner()
 *   above validates that, and the reply lands in the owner's own DM. There is
 *   no path for data to leak elsewhere.
 */

import { type Context, type MiddlewareFn, type Bot } from 'grammy';
import { and, gte, lt, asc, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { buildDigest } from '../digest/build.ts';
import { renderTemplate, type TemplateMatch, type TemplateUser } from '../publisher/templates.ts';
import { isRealtimeEvent, type EventType } from '../publisher/types.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface TestCommandsDeps {
  db: AnyDb;
  bot: Bot;
}

const DEFAULT_DIGEST_DAYS = 7;
const DEFAULT_EVENTS_DAYS = 2;
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const RUNTIME_EVENT_SEND_DELAY_MS = 350;

/**
 * Returns true iff `telegramId` matches the `TELEGRAM_OWNER_ID` env var.
 * Reads env on every call (cheap; allows mid-process env updates in tests).
 */
export function isOwner(telegramId: number | undefined): boolean {
  if (typeof telegramId !== 'number') return false;
  const raw = process.env['TELEGRAM_OWNER_ID'];
  if (!raw) return false;
  const ownerId = Number(raw);
  if (!Number.isFinite(ownerId) || ownerId === 0) return false;
  return ownerId === telegramId;
}

/**
 * Parse the positional `<days>` argument from a `/command 7` style message.
 * Returns the clamped integer in [MIN_DAYS, MAX_DAYS], or the provided fallback
 * if the argument is missing/invalid.
 */
export function parseDaysArg(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  // strip leading slash-command (with or without @botname), then take first token
  const stripped = text.replace(/^\/\S+\s*/, '').trim();
  if (!stripped) return fallback;
  const n = Number(stripped.split(/\s+/)[0]);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < MIN_DAYS) return MIN_DAYS;
  if (n > MAX_DAYS) return MAX_DAYS;
  return n;
}

const HTML_OPTS = { parse_mode: 'HTML' as const, disable_web_page_preview: true };

export function makeTestDigestHandler(deps: TestCommandsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const days = parseDaysArg(ctx.message?.text, DEFAULT_DIGEST_DAYS);
    const weekEnd = Date.now();
    const weekStart = weekEnd - days * 86400000;

    logger.info(
      { module: 'test_commands', cmd: 'test_digest', owner_id: fromId, days },
      'Building preview digest',
    );

    try {
      const result = await buildDigest({ db: deps.db, weekStart, weekEnd });

      const header = `<i>--- Preview: дайджест за последние ${days} дн. ---</i>`;
      await deps.bot.api.sendMessage(fromId!, header, HTML_OPTS);

      if (result.text) {
        await deps.bot.api.sendMessage(fromId!, result.text, HTML_OPTS);
      } else {
        await deps.bot.api.sendMessage(
          fromId!,
          '<i>(дайджест пустой — нет квалифицирующих событий за это окно)</i>',
          HTML_OPTS,
        );
      }
    } catch (err) {
      logger.error({ module: 'test_commands', cmd: 'test_digest', err }, 'Preview digest failed');
      try {
        await deps.bot.api.sendMessage(fromId!, `<i>Ошибка: ${(err as Error).message ?? 'unknown'}</i>`, HTML_OPTS);
      } catch {
        // swallow — already in error path
      }
    }
  };
}

export function makeTestRuntimeEventsHandler(deps: TestCommandsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const days = parseDaysArg(ctx.message?.text, DEFAULT_EVENTS_DAYS);
    const windowEnd = Date.now();
    const windowStart = windowEnd - days * 86400000;

    logger.info(
      { module: 'test_commands', cmd: 'test_runtime_events', owner_id: fromId, days },
      'Replaying runtime events',
    );

    try {
      const events = await deps.db
        .select({
          event_type: detectedEvents.event_type,
          riot_puuid: detectedEvents.riot_puuid,
          match_id: detectedEvents.match_id,
          payload_json: detectedEvents.payload_json,
          detected_at: detectedEvents.detected_at,
        })
        .from(detectedEvents)
        .where(and(gte(detectedEvents.detected_at, windowStart), lt(detectedEvents.detected_at, windowEnd)))
        .orderBy(asc(detectedEvents.detected_at));

      const realtimeOnly = events.filter((ev: { event_type: string }) =>
        isRealtimeEvent(ev.event_type as EventType),
      );

      const header = `<i>--- Preview: realtime-события за последние ${days} дн. (${realtimeOnly.length} шт.) ---</i>`;
      await deps.bot.api.sendMessage(fromId!, header, HTML_OPTS);

      if (realtimeOnly.length === 0) {
        await deps.bot.api.sendMessage(
          fromId!,
          '<i>(нет realtime-событий в этом окне)</i>',
          HTML_OPTS,
        );
        return;
      }

      for (const ev of realtimeOnly) {
        const puuid = ev.riot_puuid as string;
        const [userRow] = await deps.db
          .select()
          .from(users)
          .where(eq(users.riot_puuid, puuid))
          .limit(1);
        if (!userRow) continue;

        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(ev.payload_json as string) as Record<string, unknown>;
        } catch {
          payload = {};
        }

        const matchId = ev.match_id ? String(ev.match_id) : '';
        let map: string | undefined;
        if (matchId) {
          const [m] = await deps.db
            .select({ map: matchRecords.map })
            .from(matchRecords)
            .where(and(eq(matchRecords.match_id, matchId), eq(matchRecords.riot_puuid, puuid)))
            .limit(1);
          map = m?.map ? String(m.map) : undefined;
        }

        const tplUser: TemplateUser = {
          riot_name: (userRow.riot_name as string) ?? '',
          riot_tag: (userRow.riot_tag as string) ?? '',
          telegram_id: userRow.telegram_id as number,
          riot_puuid: puuid,
        };

        const tplMatch: TemplateMatch = {};
        if (map) tplMatch.map = map;
        if (matchId) tplMatch.match_id = matchId;

        const text = renderTemplate(
          ev.event_type as EventType,
          payload,
          tplUser,
          (map || matchId) ? tplMatch : undefined,
        );

        try {
          await deps.bot.api.sendMessage(fromId!, text, HTML_OPTS);
        } catch (err) {
          logger.warn(
            { module: 'test_commands', event_type: ev.event_type, err },
            'Failed to send a preview event message — continuing',
          );
        }

        // Rate-limit margin: Telegram allows ~30 msg/s to a single chat, but
        // we stay generous to avoid floods if the window is dense.
        await new Promise((r) => setTimeout(r, RUNTIME_EVENT_SEND_DELAY_MS));
      }

      await deps.bot.api.sendMessage(fromId!, `<i>--- Preview complete (${realtimeOnly.length} событий отправлено) ---</i>`, HTML_OPTS);
    } catch (err) {
      logger.error({ module: 'test_commands', cmd: 'test_runtime_events', err }, 'Preview events failed');
      try {
        await deps.bot.api.sendMessage(fromId!, `<i>Ошибка: ${(err as Error).message ?? 'unknown'}</i>`, HTML_OPTS);
      } catch {
        // swallow
      }
    }
  };
}
