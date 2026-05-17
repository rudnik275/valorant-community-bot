/**
 * test-commands.ts — Admin-only preview commands for the bot.
 *
 *   /test_digest [N]          — preview the weekly digest for the last N days
 *                               (default 7). Sent only to the owner's DM.
 *   /test_runtime_events [N]  — replay each realtime event from the last N days
 *                               (default 2) as separate messages to the owner's
 *                               DM. Pure read from detected_events — no
 *                               detector re-runs, no DB writes.
 * All commands are gated by the hardcoded `OWNER_TELEGRAM_ID` below.
 * Non-owners are silently ignored (the bot does not reply at all).
 *
 * Why sendExempt (guard-bypass path in telegram-send.ts):
 *   The allowlist guard exists to prevent leaks into unauthorised group chats.
 *   The risk model does not apply here: target = ctx.from.id = the owner who
 *   issued the command, verified by isOwner() above. The reply lands in the
 *   owner's own DM. There is no path for data to leak elsewhere.
 */

import { type Context, type MiddlewareFn, type Bot } from 'grammy';
import { and, gte, lt, asc, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { matchRosters } from '../db/schema/match_rosters.ts';
import { buildDigest } from '../digest/build.ts';
import { renderTemplate, type TemplateMatch, type TemplateUser } from '../publisher/templates.ts';
import { isRealtimeEvent, type EventType } from '../publisher/types.ts';
import logger from '../lib/log.ts';
import { sendExempt } from '../lib/telegram-send.ts';

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
      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(deps.bot.api, fromId!, header, HTML_OPTS);

      if (result.text) {
        await sendExempt(deps.bot.api, fromId!, result.text, HTML_OPTS);
      } else {
        await sendExempt(
          deps.bot.api,
          fromId!,
          '<i>(дайджест пустой — нет квалифицирующих событий за это окно)</i>',
          HTML_OPTS,
        );
      }
    } catch (err) {
      logger.error({ module: 'test_commands', cmd: 'test_digest', err }, 'Preview digest failed');
      try {
        await sendExempt(deps.bot.api, fromId!, `<i>Ошибка: ${(err as Error).message ?? 'unknown'}</i>`, HTML_OPTS);
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

      // Legacy match_comeback rows were per-player — before the grouping fix,
      // 5 community winners in one match meant 5 separate rows. The publisher
      // now emits one row per match with community_players in the payload, but
      // the historical rows still live in detected_events. Collapse them here
      // so the preview matches what the chat would see today.
      const collapsed = collapseGroupableEvents(realtimeOnly);

      const header = `<i>--- Preview: realtime-события за последние ${days} дн. (${collapsed.length} шт.) ---</i>`;
      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(deps.bot.api, fromId!, header, HTML_OPTS);

      if (collapsed.length === 0) {
        await sendExempt(
          deps.bot.api,
          fromId!,
          '<i>(нет realtime-событий в этом окне)</i>',
          HTML_OPTS,
        );
        return;
      }

      for (const ev of collapsed) {
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

        // Augment legacy match_comeback rows (saved before the grouping fix)
        // with community_players, so the rendered preview lists every winning
        // community member instead of the single triggering user.
        if (
          ev.event_type === 'match_comeback' &&
          matchId &&
          !Array.isArray(payload['community_players'])
        ) {
          const players = await fetchWinningTeamCommunity(deps.db, matchId, puuid);
          if (players.length > 0) payload['community_players'] = players;
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
          // sendExempt: destination is the owner's own DM, verified by isOwner() above.
          await sendExempt(deps.bot.api, fromId!, text, HTML_OPTS);
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

      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(deps.bot.api, fromId!, `<i>--- Preview complete (${collapsed.length} событий отправлено) ---</i>`, HTML_OPTS);
    } catch (err) {
      logger.error({ module: 'test_commands', cmd: 'test_runtime_events', err }, 'Preview events failed');
      try {
        await sendExempt(deps.bot.api, fromId!, `<i>Ошибка: ${(err as Error).message ?? 'unknown'}</i>`, HTML_OPTS);
      } catch {
        // swallow
      }
    }
  };
}

/** Event types that group all community members of one match into a single
 *  chat message. New detector runs emit one row per match for these types;
 *  legacy data may still have N rows. The preview keeps only the earliest. */
const GROUPABLE_PER_MATCH: ReadonlySet<EventType> = new Set(['match_comeback']);

interface PreviewEvent {
  event_type: string;
  riot_puuid: string;
  match_id: string | null;
  payload_json: string;
  detected_at: number;
}

/**
 * For groupable-per-match event types, keep only the earliest row per match.
 * Non-groupable types pass through untouched. Input must already be sorted by
 * detected_at ascending so "first seen" == "earliest".
 */
export function collapseGroupableEvents(events: PreviewEvent[]): PreviewEvent[] {
  const seen = new Set<string>();
  const out: PreviewEvent[] = [];
  for (const ev of events) {
    if (GROUPABLE_PER_MATCH.has(ev.event_type as EventType) && ev.match_id) {
      const key = `${ev.event_type}|${ev.match_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(ev);
  }
  return out;
}

async function fetchWinningTeamCommunity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  matchId: string,
  winnerPuuid: string,
): Promise<Array<{ puuid: string; name: string; tag: string }>> {
  const [winnerRow] = await db
    .select({ team: matchRosters.team })
    .from(matchRosters)
    .where(and(eq(matchRosters.match_id, matchId), eq(matchRosters.riot_puuid, winnerPuuid)))
    .limit(1);
  if (!winnerRow?.team) return [];

  const rows = await db
    .select({
      riot_puuid: matchRosters.riot_puuid,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
    })
    .from(matchRosters)
    .innerJoin(users, eq(users.riot_puuid, matchRosters.riot_puuid))
    .where(and(eq(matchRosters.match_id, matchId), eq(matchRosters.team, winnerRow.team as string)));

  return rows.map((r: { riot_puuid: string; riot_name: string | null; riot_tag: string | null }) => ({
    puuid: r.riot_puuid,
    name: r.riot_name ?? '',
    tag: r.riot_tag ?? '',
  }));
}

