/**
 * test-commands.ts — Admin-only preview commands for the bot.
 *
 *   /test_digest [N]          — preview the weekly digest for the last N days
 *                               (default 7). Sent only to the owner's DM.
 *   /test_runtime_events [N]  — replay each realtime event from the last N days
 *                               (default 2) as separate messages to the owner's
 *                               DM. Pure read from detected_events — no
 *                               detector re-runs, no DB writes.
 *   /test_daily_cron [N]      — preview what the daily 23:00 Kyiv cron would
 *                               post. N=0 (default): aces since the last
 *                               successful daily run, up to now (i.e. what
 *                               TODAY's cron will publish). N>=1: the window
 *                               of the cron N days ago, anchored to
 *                               [23:00 Kyiv (N+1) days ago, 23:00 Kyiv N days
 *                               ago]. Read-only — does not write to
 *                               daily_digest_runs.
 *
 * All commands are gated by the hardcoded `OWNER_TELEGRAM_ID` below.
 * Non-owners are silently ignored (the bot does not reply at all).
 *
 * Why bot.api.sendMessage directly (bypassing safe-telegram.ts):
 *   The safe-telegram wrappers exist to prevent leaks into unauthorised group
 *   chats (where community data could escape). The risk model does not apply
 *   here: target = ctx.from.id = the owner who issued the command. isOwner()
 *   above validates that, and the reply lands in the owner's own DM. There is
 *   no path for data to leak elsewhere.
 */

import { type Context, type MiddlewareFn, type Bot } from 'grammy';
import { and, gte, lt, asc, eq, isNotNull, desc } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { dailyDigestRuns } from '../db/schema/daily_digest_runs.ts';
import { buildDigest } from '../digest/build.ts';
import { buildDailyAceDigest } from '../digest-daily/build.ts';
import { getKyivDate } from '../digest-daily/loop.ts';
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
const MAX_DAILY_CRON_DAYS_BACK = 30;
const RUNTIME_EVENT_SEND_DELAY_MS = 350;

/** Hardcoded owner — admin commands work only for this telegram_id. */
export const OWNER_TELEGRAM_ID = 419486914;

/** Returns true iff `telegramId` is the bot owner. */
export function isOwner(telegramId: number | undefined): boolean {
  return typeof telegramId === 'number' && telegramId === OWNER_TELEGRAM_ID;
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

/**
 * Parse the positional `<daysBack>` argument for /test_daily_cron.
 * 0 = default (today's cron preview), N>=1 = the cron window N days ago.
 * Clamps to [0, MAX_DAILY_CRON_DAYS_BACK].
 */
export function parseDaysBackArg(text: string | undefined): number {
  if (!text) return 0;
  const stripped = text.replace(/^\/\S+\s*/, '').trim();
  if (!stripped) return 0;
  const n = Number(stripped.split(/\s+/)[0]);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 0;
  if (n < 0) return 0;
  if (n > MAX_DAILY_CRON_DAYS_BACK) return MAX_DAILY_CRON_DAYS_BACK;
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

/**
 * Find the ms epoch corresponding to 23:00 Kyiv on the given Kyiv calendar date.
 * Handles DST (EET/EEST) by trying both +2 and +3 offsets and picking the one
 * whose Kyiv-formatted time is exactly (kyivDate, 23:00).
 */
function get23KyivMsForKyivDate(kyivDate: string): number {
  const [y, mo, d] = kyivDate.split('-').map(Number);
  // Two candidates: +3 (EEST DST, late Mar → late Oct) and +2 (EET standard).
  const candidates = [
    Date.UTC(y!, mo! - 1, d!, 23 - 3, 0, 0),
    Date.UTC(y!, mo! - 1, d!, 23 - 2, 0, 0),
  ];
  for (const cand of candidates) {
    const fmtDate = getKyivDate(cand);
    const fmtHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Kyiv',
        hour: '2-digit',
        hour12: false,
      })
        .formatToParts(cand)
        .find((p) => p.type === 'hour')?.value ?? -1,
    );
    if (fmtDate === kyivDate && fmtHour === 23) return cand;
  }
  // Fallback: DST candidate (correct for May–October period).
  return candidates[0]!;
}

/**
 * Resolve the window for /test_daily_cron:
 *   daysBack = 0: windowStart = most recent daily_digest_runs.posted_at
 *              (fallback now - 24h); windowEnd = now. Previews the upcoming
 *              cron tick's output.
 *   daysBack >= 1: anchored to 23:00 Kyiv. windowEnd = 23:00 Kyiv of the
 *              calendar day `daysBack` days ago; windowStart = 23:00 Kyiv of
 *              the day before that. Previews what the cron that ran `daysBack`
 *              days ago would post under current logic.
 */
export async function resolveDailyCronWindow(
  db: AnyDb,
  daysBack: number,
  nowMs: number = Date.now(),
): Promise<{ windowStart: number; windowEnd: number }> {
  if (daysBack === 0) {
    const windowEnd = nowMs;
    const [lastRun] = await db
      .select({ posted_at: dailyDigestRuns.posted_at })
      .from(dailyDigestRuns)
      .where(isNotNull(dailyDigestRuns.posted_at))
      .orderBy(desc(dailyDigestRuns.posted_at))
      .limit(1);

    const windowStart =
      lastRun?.posted_at != null
        ? (lastRun.posted_at as number)
        : windowEnd - 24 * 3600 * 1000;

    return { windowStart, windowEnd };
  }

  // Anchor: 23:00 Kyiv on the Kyiv calendar date `daysBack` days ago.
  const endKyivDate = getKyivDate(nowMs - daysBack * 24 * 3600 * 1000);
  const [y, mo, d] = endKyivDate.split('-').map(Number);
  const startDateObj = new Date(Date.UTC(y!, mo! - 1, d!));
  startDateObj.setUTCDate(startDateObj.getUTCDate() - 1);
  const startKyivDate = `${startDateObj.getUTCFullYear()}-${String(startDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(startDateObj.getUTCDate()).padStart(2, '0')}`;

  return {
    windowStart: get23KyivMsForKyivDate(startKyivDate),
    windowEnd: get23KyivMsForKyivDate(endKyivDate),
  };
}

export function makeTestDailyCronHandler(deps: TestCommandsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const daysBack = parseDaysBackArg(ctx.message?.text);

    logger.info(
      { module: 'test_commands', cmd: 'test_daily_cron', owner_id: fromId, days_back: daysBack },
      'Building daily cron preview',
    );

    try {
      const { windowStart, windowEnd } = await resolveDailyCronWindow(deps.db, daysBack);

      const result = await buildDailyAceDigest({ db: deps.db, windowStart, windowEnd });

      if (result.text) {
        await deps.bot.api.sendMessage(fromId!, result.text, HTML_OPTS);
      } else {
        const noun = daysBack === 0 ? 'с прошлого тика' : `за окно ${daysBack} дн. назад`;
        const msg =
          `Нет ейсов ${noun}.\n` +
          `Окно: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`;
        await deps.bot.api.sendMessage(fromId!, msg, HTML_OPTS);
      }
    } catch (err) {
      logger.error({ module: 'test_commands', cmd: 'test_daily_cron', err }, 'Daily cron preview failed');
      try {
        await deps.bot.api.sendMessage(fromId!, `<i>Ошибка: ${(err as Error).message ?? 'unknown'}</i>`, HTML_OPTS);
      } catch {
        // swallow
      }
    }
  };
}
