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
import { matchRosters } from '../db/schema/match_rosters.ts';
import { buildDigest } from '../digest/build.ts';
import {
  renderGroupedTemplate,
  type EventSubject,
  type TemplateMatch,
  type TemplateUser,
} from '../publisher/templates.ts';
import { resolveTemplateMatch } from '../publisher/match-info.ts';
import { renderRichEvent, isTrioRichEvent } from '../publisher/rich-templates.ts';
import { isRealtimeEvent, type EventType } from '../publisher/types.ts';
import logger from '../lib/log.ts';
import { sendExempt, sendPhotoExempt, InputFile } from '../lib/telegram-send.ts';
import { sendRichMessageHtml } from '../lib/rich-message.ts';
import { runStoryGeneration } from '../story/run.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface TestCommandsDeps {
  db: AnyDb;
  bot: Bot;
  /**
   * Resolve the OpenAI key at command time — only used by
   * `/test_digest_image`. Optional so the other handlers' deps stay minimal.
   */
  getOpenAIKey?: () => string;
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

/**
 * `/test_digest [N]` — owner-only preview of the PRODUCTION weekly digest.
 * Since #315 the digest IS a rich message (there is no separate rich/non-rich
 * split — the plain text exists only as a prod-side send fallback), so this
 * sends `result.richHtml` — the exact same Rich Message HTML the Friday 19:00
 * publish tick posts — to the owner's DM. The former `/test_rich_digest` was
 * merged into this command (owner, 2026-07-23).
 *
 * On ANY error it replies with the error string — a preview must never fail
 * silently. (Prod never depends on this catch: the publish tick has its own
 * rich→legacy fallback.) The raw rich send is owner-DM-only: `chat_id` is
 * `ctx.from.id`, verified by `isOwner()` — same risk-model as `sendExempt`.
 */
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
      const result = await buildDigest({ db: deps.db, weekStart, weekEnd, readOnly: true });

      const header = `<i>--- Preview: дайджест за последние ${days} дн. ---</i>`;
      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(deps.bot.api, fromId!, header, HTML_OPTS);

      if (result.richHtml) {
        await sendRichMessageHtml(deps.bot.api, fromId!, result.richHtml);
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

/**
 * `/test_digest_image [N]` — owner-only promo-image preview. Builds the
 * weekly digest for the last N days (default 7), resolves the agent/map
 * reference PNGs, generates the image via OpenAI, and sends the PNG to the
 * owner's DM. NO DB writes, NO group post, NO dedup — pure prompt-iteration
 * tool so the operator doesn't have to wait until Friday.
 *
 * Refs/key missing → reply a text warning, no photo (graceful degrade,
 * same contract as the prepare tick).
 *
 * Why sendPhotoExempt: identical risk-model to `/test_digest`'s sendExempt
 * (see the module header) — destination is ctx.from.id = the owner who
 * issued the command, verified by isOwner(). The photo lands in the owner's
 * own DM; no path for data to leak elsewhere.
 */
export function makeTestDigestImageHandler(deps: TestCommandsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const days = parseDaysArg(ctx.message?.text, DEFAULT_DIGEST_DAYS);
    const weekEnd = Date.now();
    const weekStart = weekEnd - days * 86400000;

    logger.info(
      { module: 'test_commands', cmd: 'test_digest_image', owner_id: fromId, days },
      'Building preview digest image',
    );

    try {
      const apiKey = deps.getOpenAIKey?.() ?? '';
      if (!apiKey) {
        await sendExempt(
          deps.bot.api,
          fromId!,
          '<i>OPENAI_API_KEY не задан — картинку не сгенерировать.</i>',
          HTML_OPTS,
        );
        return;
      }

      const result = await buildDigest({ db: deps.db, weekStart, weekEnd, readOnly: true });
      if (result.text === null) {
        await sendExempt(
          deps.bot.api,
          fromId!,
          '<i>(дайджест пустой за это окно — нечего иллюстрировать)</i>',
          HTML_OPTS,
        );
        return;
      }

      const story = await runStoryGeneration({
        topAgent: result.topAgent,
        topMap: result.topMap,
        digestText: result.text,
        apiKey,
      });

      if (story.buffer === null) {
        const what = story.skipReason === 'missing_map_ref'
          ? `карты «${result.topMap ?? '—'}»`
          : `агента «${result.topAgent ?? '—'}»`;
        await sendExempt(
          deps.bot.api,
          fromId!,
          `<i>Нет reference-PNG для ${what} в src/assets/ — картинку не сгенерировать.</i>`,
          HTML_OPTS,
        );
        return;
      }

      // sendPhotoExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendPhotoExempt(
        deps.bot.api,
        fromId!,
        new InputFile(story.buffer, `digest-preview-${days}d.png`),
        { caption: `<i>--- Preview: промо-картинка дайджеста за ${days} дн. ---</i>`, parse_mode: 'HTML' },
      );
    } catch (err) {
      logger.error(
        { module: 'test_commands', cmd: 'test_digest_image', err },
        'Preview digest image failed',
      );
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

      // One post per (match, event type) — same rule the publisher applies, so
      // the preview shows the same number of messages the chat would get.
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

      for (const group of collapsed) {
        const ev = group.primary;
        const eventType = ev.event_type as EventType;
        const matchId = ev.match_id ? String(ev.match_id) : '';

        // Resolve every player of the group into a subject, exactly as the
        // publisher loop does — one message names all of them.
        const subjects: EventSubject[] = [];
        const heroPuuids: string[] = [];
        let primaryPayload: Record<string, unknown> = {};
        let primaryMatch: TemplateMatch | undefined;

        for (const member of group.members) {
          const puuid = member.riot_puuid;
          const [userRow] = await deps.db
            .select()
            .from(users)
            .where(eq(users.riot_puuid, puuid))
            .limit(1);
          if (!userRow) continue;

          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(member.payload_json) as Record<string, unknown>;
          } catch {
            payload = {};
          }

          // SAME resolver as the production publisher loop (replay parity,
          // #315): map / match_id / this player's agent + per-match rank /
          // teamkill victims from the roster all flow identically, so this
          // preview renders exactly what the group chat would see.
          const memberMatch: TemplateMatch | undefined = await resolveTemplateMatch(
            deps.db,
            eventType,
            member.match_id ? String(member.match_id) : '',
            puuid,
            payload,
          );

          // Augment legacy match_comeback rows (saved before the grouping fix)
          // with community_players, so the rendered preview lists every winning
          // community member instead of the single triggering user.
          if (
            eventType === 'match_comeback' &&
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

          subjects.push({
            payload,
            user: tplUser,
            ...(memberMatch ? { match: memberMatch } : {}),
          });
          heroPuuids.push(puuid);
          if (subjects.length === 1) {
            primaryPayload = payload;
            primaryMatch = memberMatch;
          }
        }

        if (subjects.length === 0) continue;

        const text = renderGroupedTemplate(eventType, subjects);

        // #315 "trio" events preview as full-roster rich tables where the data
        // is complete; fall back to the legacy plain text on null/any error so
        // the preview never breaks (mirrors the publisher loop's rich path).
        let richHtml: string | null = null;
        if (isTrioRichEvent(eventType)) {
          try {
            richHtml = await renderRichEvent(deps.db, eventType, primaryPayload, {
              ...(primaryMatch?.match_id ? { match_id: primaryMatch.match_id } : {}),
              ...(primaryMatch?.map ? { map: primaryMatch.map } : {}),
              // Replay parity (#315): giant_slayer names its subjects under the
              // title in production too.
              ...(heroPuuids.length > 0 ? { heroPuuids } : {}),
            });
          } catch (err) {
            logger.warn(
              { module: 'test_commands', event_type: eventType, err },
              'Rich preview render failed — falling back to plain text',
            );
          }
        }

        try {
          // sendExempt / sendRichMessageHtml: destination is the owner's own DM,
          // verified by isOwner() above.
          if (richHtml) {
            try {
              await sendRichMessageHtml(deps.bot.api, fromId!, richHtml);
            } catch (richErr) {
              logger.warn(
                { module: 'test_commands', event_type: ev.event_type, err: richErr },
                'Rich preview send failed — falling back to plain text',
              );
              await sendExempt(deps.bot.api, fromId!, text, HTML_OPTS);
            }
          } else {
            await sendExempt(deps.bot.api, fromId!, text, HTML_OPTS);
          }
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

interface PreviewEvent {
  event_type: string;
  riot_puuid: string;
  match_id: string | null;
  payload_json: string;
  detected_at: number;
}

/** All events of one (match, event type) — the unit the chat sees as ONE post. */
export interface PreviewGroup {
  /** Earliest event of the group; drives the match-level payload. */
  primary: PreviewEvent;
  /** Every event in the group, oldest first (`members[0] === primary`). */
  members: PreviewEvent[];
}

/**
 * Group the window's events the way the publisher does: one group per (match,
 * event type), so the preview shows exactly as many messages as the chat would.
 *
 * EVERY realtime type groups — the publisher guarantees per-match uniqueness
 * for all of them (see publisher/loop.ts), not just `match_comeback` as this
 * used to assume. Rows with no match id stand alone. Input must already be
 * sorted by detected_at ascending so `members` comes out oldest-first.
 */
export function collapseGroupableEvents(events: PreviewEvent[]): PreviewGroup[] {
  const byKey = new Map<string, PreviewGroup>();
  const out: PreviewGroup[] = [];
  for (const ev of events) {
    const groups = ev.match_id && isRealtimeEvent(ev.event_type as EventType);
    if (!groups) {
      out.push({ primary: ev, members: [ev] });
      continue;
    }
    const key = `${ev.event_type}|${ev.match_id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(ev);
      continue;
    }
    const group: PreviewGroup = { primary: ev, members: [ev] };
    byKey.set(key, group);
    out.push(group);
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

