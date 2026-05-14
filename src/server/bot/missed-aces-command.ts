/**
 * missed-aces-command.ts — Admin `/post_missed_aces [N]`.
 *
 * Goal: re-detect aces with the post-ADR-0003 logic for matches scanned BEFORE
 * the new detector shipped, and post a one-shot "Daily Ace (пропущенные за …)"
 * message for the aces no longer represented in detected_events.
 *
 * Flow mirrors /congrats: preview to owner DM with inline ✅/❌, on ✅ post to
 * TELEGRAM_PRIMARY_CHAT_ID. Previews live in memory keyed by a short id and
 * expire after 30 min.
 */

import { type Context, type MiddlewareFn, type Bot, InlineKeyboard } from 'grammy';
import { and, eq, gte, lt } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { isOwner, parseDaysBackArg, resolveDailyCronWindow } from './test-commands.ts';
import { findAces } from '../publisher/detectors/ace.ts';
import { renderDailyAceText, type Line } from '../digest-daily/build.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface MissedAcesDeps {
  db: AnyDb;
  bot: Bot;
  getPrimaryChatId: () => number;
}

const HTML_OPTS = { parse_mode: 'HTML' as const, disable_web_page_preview: true };
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const CALLBACK_PREFIX = 'missed_aces:';

interface Preview {
  text: string;
  ownerId: number;
  createdAt: number;
}

const previewStore = new Map<string, Preview>();

/** Exported for tests only. */
export function _clearMissedAcesPreviewsForTest(): void {
  previewStore.clear();
}

function gcPreviews(): void {
  const now = Date.now();
  for (const [k, v] of previewStore) {
    if (now - v.createdAt > PREVIEW_TTL_MS) previewStore.delete(k);
  }
}

function newPreviewId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Find aces that the post-ADR-0003 detector would emit for tracked users'
 * matches in `[windowStart, windowEnd)`, excluding any (puuid, match_id) pair
 * that already has an ace row in detected_events.
 */
export async function findMissedAces(
  db: AnyDb,
  windowStart: number,
  windowEnd: number,
): Promise<Line[]> {
  const records = await db
    .select()
    .from(matchRecords)
    .where(and(gte(matchRecords.started_at, windowStart), lt(matchRecords.started_at, windowEnd)));

  const existing = await db
    .select({ matchId: detectedEvents.match_id, puuid: detectedEvents.riot_puuid })
    .from(detectedEvents)
    .where(eq(detectedEvents.event_type, 'ace'));
  const existingKey = new Set<string>(
    (existing as Array<{ matchId: string; puuid: string | null }>).map((e) => `${e.puuid ?? ''}::${e.matchId}`),
  );

  const allUsers = await db.select().from(users);
  const userByPuuid = new Map<string, { riot_name: string | null; riot_tag: string | null }>();
  for (const u of allUsers as Array<{ riot_puuid: string | null; riot_name: string | null; riot_tag: string | null }>) {
    if (u.riot_puuid) userByPuuid.set(u.riot_puuid, { riot_name: u.riot_name, riot_tag: u.riot_tag });
  }

  const lines: Line[] = [];
  for (const rec of records as Array<{
    riot_puuid: string | null;
    match_id: string;
    started_at: number;
    map: string;
    agent: string;
    rounds_compact: string | null;
    kill_events_compact: string;
  }>) {
    const puuid = rec.riot_puuid;
    if (!puuid) continue;
    if (existingKey.has(`${puuid}::${rec.match_id}`)) continue;
    // findAces consumes the MatchRecord shape — these rows are the same table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aces = findAces(rec as any);
    if (aces.length === 0) continue;
    const u = userByPuuid.get(puuid);
    const sortedAces = [...aces].sort((a, b) => a.round - b.round);
    lines.push({
      eventId: 0,
      riotName: u?.riot_name ?? puuid,
      riotTag: u?.riot_tag ?? '',
      agent: rec.agent,
      map: rec.map,
      matchId: rec.match_id,
      rounds: sortedAces.map((a) => a.round),
      roundsWon: sortedAces.filter((a) => a.won).map((a) => a.round),
      detectedAt: rec.started_at,
    });
  }

  return lines.sort((a, b) => a.detectedAt - b.detectedAt);
}

export function makePostMissedAcesHandler(deps: MissedAcesDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const daysBack = parseDaysBackArg(ctx.message?.text);
    if (daysBack < 1) {
      await deps.bot.api.sendMessage(
        fromId!,
        '<i>Используй N≥1, например /post_missed_aces 1 (вчера).</i>',
        HTML_OPTS,
      );
      return;
    }

    logger.info(
      { module: 'missed_aces', cmd: 'post_missed_aces', owner_id: fromId, days_back: daysBack },
      'Building missed-aces preview',
    );

    try {
      const { windowStart, windowEnd } = await resolveDailyCronWindow(deps.db, daysBack);
      const lines = await findMissedAces(deps.db, windowStart, windowEnd);

      if (lines.length === 0) {
        await deps.bot.api.sendMessage(
          fromId!,
          `<i>Нет пропущенных эйсов за окно ${daysBack} дн. назад.</i>\n` +
            `<i>Окно: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}</i>`,
          HTML_OPTS,
        );
        return;
      }

      const headerNote = `(пропущенные за ${daysBack} дн. назад)`;
      const text = renderDailyAceText(lines, headerNote);

      gcPreviews();
      const previewId = newPreviewId();
      previewStore.set(previewId, { text, ownerId: fromId!, createdAt: Date.now() });

      const keyboard = new InlineKeyboard()
        .text('✅ В группу', `${CALLBACK_PREFIX}send:${previewId}`)
        .text('❌ Отмена', `${CALLBACK_PREFIX}cancel:${previewId}`);

      await deps.bot.api.sendMessage(
        fromId!,
        `<i>Превью (живёт 30 мин):</i>\n\n${text}`,
        { ...HTML_OPTS, reply_markup: keyboard },
      );
    } catch (err) {
      logger.error({ module: 'missed_aces', err }, 'post_missed_aces preview failed');
      try {
        await deps.bot.api.sendMessage(
          fromId!,
          `<i>Ошибка: ${escHtml((err as Error).message ?? 'unknown')}</i>`,
          HTML_OPTS,
        );
      } catch {
        // swallow
      }
    }
  };
}

export function makePostMissedAcesCallbackHandler(deps: MissedAcesDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) {
      await ctx.answerCallbackQuery({ text: 'Не для тебя', show_alert: false });
      return;
    }

    const data = ctx.callbackQuery?.data ?? '';
    const match = data.match(/^missed_aces:(send|cancel):(.+)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }
    const action = match[1]!;
    const previewId = match[2]!;

    gcPreviews();
    const preview = previewStore.get(previewId);
    if (!preview) {
      await ctx.answerCallbackQuery({ text: 'Превью истекло', show_alert: true });
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // ignore
      }
      return;
    }
    if (preview.ownerId !== fromId) {
      await ctx.answerCallbackQuery({ text: 'Не для тебя', show_alert: false });
      return;
    }

    if (action === 'cancel') {
      previewStore.delete(previewId);
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // ignore
      }
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      return;
    }

    const chatId = deps.getPrimaryChatId();
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'TELEGRAM_PRIMARY_CHAT_ID не задан', show_alert: true });
      return;
    }

    try {
      await deps.bot.api.sendMessage(chatId, preview.text, HTML_OPTS);
      previewStore.delete(previewId);
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // ignore
      }
      await ctx.answerCallbackQuery({ text: '✅ Отправлено' });
      logger.info(
        { module: 'missed_aces', owner_id: fromId, chat_id: chatId },
        'Missed aces posted to group',
      );
    } catch (err) {
      logger.error({ module: 'missed_aces', err }, 'Failed to post missed aces');
      await ctx.answerCallbackQuery({
        text: `Ошибка: ${(err as Error).message?.slice(0, 180) ?? 'unknown'}`,
        show_alert: true,
      });
    }
  };
}
