/**
 * congrats-command.ts — Admin command `/congrats <nickname>`.
 *
 * Flow:
 *   1. Owner DMs `/congrats Валер` → bot looks up the player by partial
 *      case-insensitive match on users.riot_name.
 *   2. 0 candidates → error in DM. >1 candidates → list them in DM.
 *   3. 1 candidate → build a congrats text for YESTERDAY's competitive
 *      matches (Kyiv calendar day), send to owner's DM as a preview with
 *      inline keyboard: ✅ Отправить в группу / ❌ Отмена.
 *   4. ✅ → post the saved text to TELEGRAM_PRIMARY_CHAT_ID, drop preview.
 *   5. ❌ → drop preview, no post.
 *
 * Previews live in memory keyed by a short random id, expire after 30 min.
 * Single-process bot so an in-memory Map is sufficient; the worst case on
 * restart is the user has to /congrats again.
 *
 * Why sendExempt (guard-bypass path in telegram-send.ts — same reasoning as
 * test-commands.ts:14-20): the destinations are either the owner's DM
 * (gated by isOwner) or TELEGRAM_PRIMARY_CHAT_ID (the already-authorised
 * group chat confirmed by explicit owner action), so the unauthorised-leak
 * risk model does not apply.
 */

import { type Context, type MiddlewareFn, type Bot, InlineKeyboard } from 'grammy';
import { and, eq, gte, lt, asc, like, sql } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { isOwner } from './test-commands.ts';
import logger from '../lib/log.ts';
import { sendExempt } from '../lib/telegram-send.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface CongratsDeps {
  db: AnyDb;
  bot: Bot;
  /** Resolved lazily because index.ts reads the env after bot creation. */
  getPrimaryChatId: () => number;
}

const HTML_OPTS = { parse_mode: 'HTML' as const, disable_web_page_preview: true };
const TZ = 'Europe/Kyiv';
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const CALLBACK_PREFIX = 'congrats:';

interface Preview {
  text: string;
  ownerId: number;
  createdAt: number;
}

const previewStore = new Map<string, Preview>();

/** Exported for tests only. */
export function _clearPreviewsForTest(): void {
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

function ruWins(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'побед';
  const mod10 = n % 10;
  if (mod10 === 1) return 'победа';
  if (mod10 >= 2 && mod10 <= 4) return 'победы';
  return 'побед';
}

/** Kyiv-midnight epoch ms `daysAgo` calendar days ago (0 = today). */
function kyivMidnightMs(daysAgo: number): number {
  const targetMs = Date.now() - daysAgo * 86400000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(targetMs);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  // Use +03:00 (EEST is +03:00 year-round in Kyiv since 2014 — same approach as
  // computeWeekIso in scripts/launch/backfill-records.ts).
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
}

function fmtTimeKyiv(ms: number): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

interface PlayerRow {
  riot_puuid: string;
  riot_name: string;
  riot_tag: string | null;
}

interface MatchRow {
  started_at: number;
  map: string;
  kills: number;
  deaths: number;
  assists: number;
  result: string;
  enemy_avg_rank: string | null;
}

async function findPlayerCandidates(db: AnyDb, nickname: string): Promise<PlayerRow[]> {
  const q = `%${nickname.toLowerCase()}%`;
  const rows = await db
    .select({
      riot_puuid: users.riot_puuid,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
    })
    .from(users)
    .where(like(sql`LOWER(${users.riot_name})`, q));
  return rows.filter((r: PlayerRow) => !!r.riot_puuid);
}

async function fetchMatches(db: AnyDb, puuid: string, dayStart: number, dayEnd: number): Promise<MatchRow[]> {
  return await db
    .select({
      started_at: matchRecords.started_at,
      map: matchRecords.map,
      kills: matchRecords.kills,
      deaths: matchRecords.deaths,
      assists: matchRecords.assists,
      result: matchRecords.result,
      enemy_avg_rank: matchRecords.enemy_avg_rank,
    })
    .from(matchRecords)
    .where(
      and(
        eq(matchRecords.riot_puuid, puuid),
        gte(matchRecords.started_at, dayStart),
        lt(matchRecords.started_at, dayEnd),
      ),
    )
    .orderBy(asc(matchRecords.started_at));
}

export function buildCongratsText(player: PlayerRow, matches: MatchRow[]): string | null {
  if (matches.length === 0) return null;
  let tK = 0;
  let tD = 0;
  let wins = 0;
  const lines: string[] = [];
  for (const m of matches) {
    const badge = m.result === 'win' ? '🏆' : m.result === 'loss' ? '💀' : '🤝';
    const rank = m.enemy_avg_rank ?? 'unrated';
    lines.push(
      `${badge} <b>${fmtTimeKyiv(m.started_at)}</b> · Средний ранг - <b>${escHtml(rank)}</b>, ${escHtml(m.map)}  K/D/A <b>${m.kills}/${m.deaths}/${m.assists}</b>`,
    );
    tK += m.kills;
    tD += m.deaths;
    if (m.result === 'win') wins++;
  }
  const kdStr = tD === 0 ? `${tK} (без смертей)` : (tK / tD).toFixed(2);
  return [
    `🎉 <b>${escHtml(player.riot_name)}</b> сегодня в форме!`,
    '',
    ...lines,
    '',
    `📊 За сегодняшний день · K/D <b>${kdStr}</b> · ${wins} ${ruWins(wins)} 🏆`,
    '',
    '👏👏👏 Овации! 👏👏👏',
  ].join('\n');
}

export function makeCongratsHandler(deps: CongratsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) return; // silent ignore

    const text = ctx.message?.text ?? '';
    const arg = text.replace(/^\/\S+\s*/, '').trim();
    if (!arg) {
      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(
        deps.bot.api,
        fromId!,
        'Использование: <code>/congrats никнейм</code>\nИщет по частичному совпадению в riot_name.',
        HTML_OPTS,
      );
      return;
    }

    try {
      const candidates = await findPlayerCandidates(deps.db, arg);

      if (candidates.length === 0) {
        // sendExempt: destination is the owner's own DM, verified by isOwner() above.
        await sendExempt(
          deps.bot.api,
          fromId!,
          `❌ Игроков с ником содержащим <b>${escHtml(arg)}</b> не найдено.`,
          HTML_OPTS,
        );
        return;
      }

      if (candidates.length > 1) {
        const list = candidates
          .map((c) => `• ${escHtml(c.riot_name)}#${escHtml(c.riot_tag ?? '')}`)
          .join('\n');
        // sendExempt: destination is the owner's own DM, verified by isOwner() above.
        await sendExempt(
          deps.bot.api,
          fromId!,
          `❌ Найдено несколько игроков:\n${list}\n\nУточни ник или укажи целиком.`,
          HTML_OPTS,
        );
        return;
      }

      const player = candidates[0]!;
      // Window: today 00:00 Kyiv → now. The most common use case is an
      // evening recap after a session — yesterday's calendar day is less
      // useful and surprised the owner when first deployed.
      const dayStart = kyivMidnightMs(0);
      const dayEnd = Date.now();
      const matches = await fetchMatches(deps.db, player.riot_puuid, dayStart, dayEnd);
      const congrats = buildCongratsText(player, matches);

      if (!congrats) {
        // sendExempt: destination is the owner's own DM, verified by isOwner() above.
        await sendExempt(
          deps.bot.api,
          fromId!,
          `<b>${escHtml(player.riot_name)}</b> сегодня не играл(а) competitive — нечего отправлять.`,
          HTML_OPTS,
        );
        return;
      }

      gcPreviews();
      const previewId = newPreviewId();
      previewStore.set(previewId, { text: congrats, ownerId: fromId!, createdAt: Date.now() });

      const keyboard = new InlineKeyboard()
        .text('✅ В группу', `${CALLBACK_PREFIX}send:${previewId}`)
        .text('❌ Отмена', `${CALLBACK_PREFIX}cancel:${previewId}`);

      // sendExempt: destination is the owner's own DM, verified by isOwner() above.
      await sendExempt(
        deps.bot.api,
        fromId!,
        `<i>Превью (живёт 30 мин):</i>\n\n${congrats}`,
        { ...HTML_OPTS, reply_markup: keyboard },
      );
    } catch (err) {
      logger.error({ module: 'congrats', cmd: '/congrats', err }, 'Command failed');
      try {
        // sendExempt: destination is the owner's own DM, verified by isOwner() above.
        await sendExempt(
          deps.bot.api,
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

export function makeCongratsCallbackHandler(deps: CongratsDeps): MiddlewareFn<Context> {
  return async (ctx: Context): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!isOwner(fromId)) {
      await ctx.answerCallbackQuery({ text: 'Не для тебя', show_alert: false });
      return;
    }

    const data = ctx.callbackQuery?.data ?? '';
    const match = data.match(/^congrats:(send|cancel):(.+)$/);
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
        // ignore — message may be too old or already edited
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

    // action === 'send'
    const chatId = deps.getPrimaryChatId();
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'TELEGRAM_PRIMARY_CHAT_ID не задан', show_alert: true });
      return;
    }

    try {
      // sendExempt: destination is TELEGRAM_PRIMARY_CHAT_ID (the already-authorised
      // group), confirmed by explicit owner action (pressing ✅ in the callback).
      await sendExempt(deps.bot.api, chatId, preview.text, HTML_OPTS);
      previewStore.delete(previewId);
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // ignore
      }
      await ctx.answerCallbackQuery({ text: '✅ Отправлено' });
      logger.info({ module: 'congrats', owner_id: fromId, chat_id: chatId }, 'Congrats posted to group');
    } catch (err) {
      logger.error({ module: 'congrats', err }, 'Failed to send congrats to group');
      await ctx.answerCallbackQuery({
        text: `Ошибка: ${(err as Error).message?.slice(0, 180) ?? 'unknown'}`,
        show_alert: true,
      });
    }
  };
}
