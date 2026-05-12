import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import {
  buildCongratsText,
  makeCongratsHandler,
  makeCongratsCallbackHandler,
  _clearPreviewsForTest,
} from './congrats-command.ts';
import { OWNER_TELEGRAM_ID } from './test-commands.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');
const PRIMARY_CHAT_ID = -1001234567890;

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

function seedUser(sqlite: Database.Database, opts: { telegramId: number; puuid: string; name: string; tag: string }) {
  sqlite.prepare(
    `INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag, riot_region, joined_at)
     VALUES (?, ?, ?, ?, 'eu', ?)`,
  ).run(opts.telegramId, opts.puuid, opts.name, opts.tag, Date.now());
}

function seedMatch(sqlite: Database.Database, opts: {
  puuid: string; matchId: string; startedAt: number; map?: string; agent?: string;
  kills: number; deaths: number; assists: number; result: 'win' | 'loss' | 'draw';
  enemyAvgRank?: string | null;
}) {
  sqlite.prepare(
    `INSERT INTO match_records
     (riot_puuid, match_id, started_at, map, agent, kills, deaths, assists, result,
      rounds_played, kill_events_compact, enemy_avg_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 25, '[]', ?)`,
  ).run(
    opts.puuid, opts.matchId, opts.startedAt,
    opts.map ?? 'Ascent', opts.agent ?? 'Jett',
    opts.kills, opts.deaths, opts.assists, opts.result,
    opts.enemyAvgRank ?? null,
  );
}

function kyivMidnightMs(daysAgo: number): number {
  const target = new Date(Date.now() - daysAgo * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(target);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
}

function makeMockBot() {
  return {
    api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }) },
  };
}

describe('buildCongratsText', () => {
  const player = { riot_puuid: 'p1', riot_name: 'Tester', riot_tag: 'EU1' };

  it('returns null when no matches', () => {
    expect(buildCongratsText(player, [])).toBeNull();
  });

  it('renders match lines with badge, map, rank, K/D/A', () => {
    const text = buildCongratsText(player, [
      { started_at: 1700000000000, map: 'Haven', kills: 20, deaths: 10, assists: 5, result: 'win', enemy_avg_rank: 'Diamond 2' },
      { started_at: 1700000003600000, map: 'Ascent', kills: 15, deaths: 16, assists: 3, result: 'loss', enemy_avg_rank: null },
    ])!;
    expect(text).toContain('<b>Tester</b>');
    expect(text).toContain('Haven');
    expect(text).toContain('Diamond 2');
    expect(text).toContain('20/10/5');
    expect(text).toContain('unrated'); // null enemy rank
    expect(text).toContain('🏆'); // win badge
    expect(text).toContain('💀'); // loss badge
  });

  it('handles 0 deaths without dividing by zero', () => {
    const text = buildCongratsText(player, [
      { started_at: 1700000000000, map: 'Haven', kills: 12, deaths: 0, assists: 3, result: 'win', enemy_avg_rank: 'Gold 1' },
    ])!;
    expect(text).toContain('12 (без смертей)');
  });

  it('uses correct Russian plural for wins count', () => {
    // 2 wins → "победы"
    const t2 = buildCongratsText(player, [
      { started_at: 1700000000000, map: 'Haven', kills: 1, deaths: 1, assists: 0, result: 'win', enemy_avg_rank: null },
      { started_at: 1700003600000, map: 'Haven', kills: 1, deaths: 1, assists: 0, result: 'win', enemy_avg_rank: null },
    ])!;
    expect(t2).toContain('2 победы');

    // 5 wins → "побед"
    const t5 = buildCongratsText(player, Array.from({ length: 5 }, (_, i) => ({
      started_at: 1700000000000 + i * 3600000, map: 'Haven', kills: 1, deaths: 1, assists: 0,
      result: 'win' as const, enemy_avg_rank: null,
    })))!;
    expect(t5).toContain('5 побед');

    // 1 win → "победа"
    const t1 = buildCongratsText(player, [
      { started_at: 1700000000000, map: 'Haven', kills: 1, deaths: 1, assists: 0, result: 'win', enemy_avg_rank: null },
    ])!;
    expect(t1).toContain('1 победа');
  });

  it('escapes HTML in player name and map', () => {
    const evil = { riot_puuid: 'p1', riot_name: '<script>x</script>', riot_tag: 'EU1' };
    const text = buildCongratsText(evil, [
      { started_at: 1700000000000, map: '<img>', kills: 1, deaths: 1, assists: 0, result: 'win', enemy_avg_rank: null },
    ])!;
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
  });
});

describe('makeCongratsHandler', () => {
  let testDb: ReturnType<typeof makeTestDb>;
  let bot: ReturnType<typeof makeMockBot>;

  beforeEach(() => {
    testDb = makeTestDb();
    bot = makeMockBot();
    _clearPreviewsForTest();
  });

  afterEach(() => {
    testDb.sqlite.close();
  });

  it('silently ignores non-owner', async () => {
    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: 99999 }, message: { text: '/congrats Valer' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('responds with usage when no arg given', async () => {
    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    const [, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(body).toContain('Использование');
  });

  it('responds "not found" when no player matches', async () => {
    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats nobody' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    const [, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(body).toContain('не найдено');
  });

  it('lists candidates when multiple players match', async () => {
    seedUser(testDb.sqlite, { telegramId: 1, puuid: 'p-a', name: 'ValerA', tag: '1111' });
    seedUser(testDb.sqlite, { telegramId: 2, puuid: 'p-b', name: 'ValerB', tag: '2222' });

    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats Valer' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    const [, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(body).toContain('несколько игроков');
    expect(body).toContain('ValerA');
    expect(body).toContain('ValerB');
  });

  it('responds with no-matches message when player has no yesterday matches', async () => {
    seedUser(testDb.sqlite, { telegramId: 1, puuid: 'p-a', name: 'Lonely', tag: '0000' });
    // No match seeded → empty result

    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats Lonely' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    const [, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(body).toContain('не играл(а)');
  });

  it('sends preview with inline keyboard when player has yesterday matches', async () => {
    seedUser(testDb.sqlite, { telegramId: 1, puuid: 'p-a', name: 'Champ', tag: '7777' });
    // Seed a match at yesterday-12:00 Kyiv
    const yest12 = kyivMidnightMs(1) + 12 * 3600 * 1000;
    seedMatch(testDb.sqlite, {
      puuid: 'p-a', matchId: 'm-yest', startedAt: yest12, kills: 25, deaths: 10, assists: 5,
      result: 'win', enemyAvgRank: 'Platinum 2',
    });

    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats Champ' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    const [chatId, body, opts] = bot.api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(OWNER_TELEGRAM_ID);
    expect(body).toContain('Champ');
    expect(body).toContain('25/10/5');
    expect(body).toContain('Platinum 2');
    expect(opts).toMatchObject({ parse_mode: 'HTML' });
    // Inline keyboard present with both buttons
    expect(opts.reply_markup).toBeDefined();
    const buttons = opts.reply_markup.inline_keyboard.flat();
    expect(buttons.some((b: { callback_data: string }) => b.callback_data.startsWith('congrats:send:'))).toBe(true);
    expect(buttons.some((b: { callback_data: string }) => b.callback_data.startsWith('congrats:cancel:'))).toBe(true);
  });

  it('does not include today\'s matches in the preview', async () => {
    seedUser(testDb.sqlite, { telegramId: 1, puuid: 'p-a', name: 'Champ', tag: '7777' });
    // Yesterday at 14:00
    const yest14 = kyivMidnightMs(1) + 14 * 3600 * 1000;
    seedMatch(testDb.sqlite, {
      puuid: 'p-a', matchId: 'm-yest', startedAt: yest14, kills: 5, deaths: 5, assists: 5,
      result: 'win',
    });
    // Today at 02:00 Kyiv (after yesterday's window)
    const today02 = kyivMidnightMs(0) + 2 * 3600 * 1000;
    seedMatch(testDb.sqlite, {
      puuid: 'p-a', matchId: 'm-today', startedAt: today02, kills: 99, deaths: 0, assists: 0,
      result: 'win',
    });

    const handler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats Champ' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    const [, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(body).toContain('5/5/5'); // yesterday match present
    expect(body).not.toContain('99/0/0'); // today match excluded
  });
});

describe('makeCongratsCallbackHandler', () => {
  let testDb: ReturnType<typeof makeTestDb>;
  let bot: ReturnType<typeof makeMockBot>;

  beforeEach(() => {
    testDb = makeTestDb();
    bot = makeMockBot();
    _clearPreviewsForTest();
  });

  afterEach(() => {
    testDb.sqlite.close();
  });

  async function seedPreview(): Promise<string> {
    // Run the command handler to produce a real preview in the store.
    seedUser(testDb.sqlite, { telegramId: 1, puuid: 'p-a', name: 'Champ', tag: '7777' });
    const yest12 = kyivMidnightMs(1) + 12 * 3600 * 1000;
    seedMatch(testDb.sqlite, {
      puuid: 'p-a', matchId: 'm-yest', startedAt: yest12, kills: 1, deaths: 1, assists: 1,
      result: 'win',
    });
    const cmdHandler = makeCongratsHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const ctx = { from: { id: OWNER_TELEGRAM_ID }, message: { text: '/congrats Champ' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cmdHandler(ctx as any, async () => {});
    const opts = bot.api.sendMessage.mock.calls[0]![2];
    const button = opts.reply_markup.inline_keyboard.flat()
      .find((b: { callback_data: string }) => b.callback_data.startsWith('congrats:send:'));
    return button!.callback_data; // e.g. 'congrats:send:abc-xyz'
  }

  it('non-owner callback answered but no DB action', async () => {
    const handler = makeCongratsCallbackHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: 99999 },
      callbackQuery: { data: 'congrats:send:fake-id' },
      answerCallbackQuery,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled(); // no group post
  });

  it('expired (unknown) preview id → alert', async () => {
    const handler = makeCongratsCallbackHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: OWNER_TELEGRAM_ID },
      callbackQuery: { data: 'congrats:send:does-not-exist' },
      answerCallbackQuery, editMessageReplyMarkup,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('истекло'),
      show_alert: true,
    }));
  });

  it('cancel removes preview and strips keyboard', async () => {
    const sendData = await seedPreview();
    const cancelData = sendData.replace(':send:', ':cancel:');

    const handler = makeCongratsCallbackHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: OWNER_TELEGRAM_ID },
      callbackQuery: { data: cancelData },
      answerCallbackQuery, editMessageReplyMarkup,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(editMessageReplyMarkup).toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Отменено' }));
    expect(bot.api.sendMessage).toHaveBeenCalledOnce(); // only the original preview send
  });

  it('send posts to primary chat and removes keyboard', async () => {
    const sendData = await seedPreview();
    bot.api.sendMessage.mockClear();
    bot.api.sendMessage.mockResolvedValue({ message_id: 7777 });

    const handler = makeCongratsCallbackHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: OWNER_TELEGRAM_ID },
      callbackQuery: { data: sendData },
      answerCallbackQuery, editMessageReplyMarkup,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});

    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    const [chatId, body] = bot.api.sendMessage.mock.calls[0]!;
    expect(chatId).toBe(PRIMARY_CHAT_ID);
    expect(body).toContain('Champ');
    expect(editMessageReplyMarkup).toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: '✅ Отправлено' }));
  });

  it('reuse of same preview after send → alert (preview consumed)', async () => {
    const sendData = await seedPreview();
    const handler = makeCongratsCallbackHandler({
      db: testDb.db, bot: bot as never, getPrimaryChatId: () => PRIMARY_CHAT_ID,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);
    const ctx = {
      from: { id: OWNER_TELEGRAM_ID },
      callbackQuery: { data: sendData },
      answerCallbackQuery, editMessageReplyMarkup,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    answerCallbackQuery.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(answerCallbackQuery).toHaveBeenLastCalledWith(expect.objectContaining({
      text: expect.stringContaining('истекло'),
    }));
  });
});
