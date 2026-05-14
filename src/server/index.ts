import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { Bot } from 'grammy';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import logger from './lib/log.ts';
import { db } from './db/client.ts';
import healthz from './api/healthz.ts';
import { scopeGuard } from './bot/scope-guard.ts';
import { makeLastMessageHandler } from './bot/listener.ts';
import { makeChatMemberListener } from './bot/chat-member-listener.ts';
import { makeTestDigestHandler, makeTestRuntimeEventsHandler, makeTestDailyCronHandler } from './bot/test-commands.ts';
import { makeCongratsHandler, makeCongratsCallbackHandler } from './bot/congrats-command.ts';
import { makePostMissedAcesHandler, makePostMissedAcesCallbackHandler } from './bot/missed-aces-command.ts';
import { setupAdminCommandsForOwner } from './bot/setup-admin-commands.ts';
import { isAllowedChat } from './lib/scope.ts';
import { makeAuthMiddleware } from './api/auth.ts';
import { makeMembersHandler } from './api/members.ts';
import { makeOnboardHandler } from './api/onboard.ts';
import { makeMeHandler } from './api/me.ts';
import { verifyInitData } from './lib/init-data.ts';
import { sql } from 'drizzle-orm';
import { users } from './db/schema/users.ts';
import { makeAvatarCache } from './lib/telegram-avatar.ts';
import { validateAccount, getAccountByPuuid } from './lib/henrik.ts';
import { loadAllowedChatIds } from './lib/scope.ts';
import { scanForPuuid as scanForPuuidBase, startScanLoop } from './scanner/index.ts';
import { startRiotIdTrackerLoop } from './scanner/riot-id-tracker.ts';
import { startDetectionListener } from './publisher/detect.ts';
import { startPublisherLoop } from './publisher/loop.ts';
import { startDigestLoop } from './digest/loop.ts';
import { startDailyDigestLoop } from './digest-daily/loop.ts';
import { startRestrictGraceLoop } from './cron/restrict-grace.ts';
import { startRetryPendingOnboardLoop } from './cron/retry-pending-onboard.ts';
import { safeSendMessage, safeSetCustomTitle } from './lib/safe-telegram.ts';
import { isPublishingEnabled } from './lib/silent-period.ts';

const PORT = Number(process.env['PORT'] ?? 3000);

const app = new Hono();

// Routes
app.route('/healthz', healthz);

// Bot setup
const botToken = process.env['TELEGRAM_BOT_TOKEN'];
let bot: Bot | undefined;
if (botToken) {
  bot = new Bot(botToken);
  bot.use(scopeGuard);
  // Admin-only preview commands. Gated internally by isOwner() (TELEGRAM_OWNER_ID).
  bot.command('test_digest', makeTestDigestHandler({ db, bot }));
  bot.command('test_runtime_events', makeTestRuntimeEventsHandler({ db, bot }));
  bot.command('test_daily_cron', makeTestDailyCronHandler({ db, bot }));
  // Admin: /congrats <nickname> → preview-then-confirm post of yesterday's
  // matches for the matched player to the primary chat.
  const getPrimaryChatId = () => Number(process.env['TELEGRAM_PRIMARY_CHAT_ID'] ?? '0');
  bot.command('congrats', makeCongratsHandler({ db, bot, getPrimaryChatId }));
  bot.callbackQuery(/^congrats:/, makeCongratsCallbackHandler({ db, bot, getPrimaryChatId }));
  bot.command('post_missed_aces', makePostMissedAcesHandler({ db, bot, getPrimaryChatId }));
  bot.callbackQuery(/^missed_aces:/, makePostMissedAcesCallbackHandler({ db, bot, getPrimaryChatId }));
  const lastMessageHandler = makeLastMessageHandler({ db, isAllowedChat });
  bot.on('message', lastMessageHandler);
  bot.on('chat_member', makeChatMemberListener({ db, isAllowedChat }));
  bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message', 'my_chat_member', 'chat_member', 'callback_query'],
  }).catch((err) => {
    logger.error({ module: 'bot', err }, 'grammY bot failed to start');
  });
  // Owner-only "/" quick-pick menu in the owner's DM (admin commands).
  // Fire-and-forget — failures are logged but don't block startup.
  void setupAdminCommandsForOwner(bot);
  logger.info({ module: 'bot' }, 'Telegram bot started (long-polling)');
} else {
  logger.warn({ module: 'bot' }, 'TELEGRAM_BOT_TOKEN not set — bot disabled (dev mode)');
}

// Digest loop is started below inside the `if (bot)` block after publisher.

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info({ module: 'startup' }, 'SIGTERM received — shutting down gracefully');
  bot?.stop();
  process.exit(0);
});

// Run DB migrations synchronously before starting the server
try {
  migrate(db, { migrationsFolder: './drizzle' });
  logger.info({ module: 'startup' }, 'DB migrations applied successfully');
  logger.info(
    {
      module: 'startup',
      publishing_enabled: isPublishingEnabled(),
      enabled_after: process.env['EVENTS_PUBLISHING_ENABLED_AFTER'] ?? null,
    },
    'Silent-period state at boot',
  );
} catch (err) {
  logger.error({ module: 'startup', err }, 'DB migration failed — exiting');
  process.exit(1);
}

// API middleware + routes
const currentBotToken = botToken ?? '';
const authMiddleware = makeAuthMiddleware({
  verify: (raw) => verifyInitData(raw, currentBotToken),
  upsertUser: async (user) => {
    await db
      .insert(users)
      .values({
        telegram_id: user.id,
        telegram_username: user.username ?? null,
      })
      .onConflictDoUpdate({
        target: users.telegram_id,
        set: {
          // COALESCE: preserve existing username if initData omits it (privacy/no username)
          telegram_username: sql`COALESCE(excluded.telegram_username, ${users.telegram_username})`,
        },
      });
  },
});

// Avatar cache (lazy, fire-and-forget)
const avatarCache = bot
  ? makeAvatarCache({
      db,
      getApi: () => bot!.api,
      getBotToken: () => currentBotToken,
    })
  : null;

const membersDeps = avatarCache
  ? {
      db,
      refreshAvatarIfStale: (id: number) => {
        avatarCache.ensureAvatar(id).catch((err) => {
          logger.warn({ module: 'avatar', err, telegram_id: id }, 'Avatar refresh failed');
        });
      },
    }
  : { db };
const membersHandler = makeMembersHandler(membersDeps);

app.use('/api/*', authMiddleware);
app.get('/api/members', membersHandler);

// Bind scanForPuuid to the main db instance for use in onboard handler and loop
const scanForPuuid = (puuid: string, opts: { detection: boolean }) =>
  scanForPuuidBase(db, puuid, opts);

if (process.env['SCANNER_DISABLED'] !== 'true') {
  startDetectionListener({ db });
  startScanLoop({ db, scanForPuuid });

  if (bot) {
    const primaryChatId = Number(process.env['TELEGRAM_PRIMARY_CHAT_ID'] ?? '0');
    if (primaryChatId) {
      startPublisherLoop({
        db,
        sendMessage: (chatId, text, opts) => safeSendMessage(
          bot!.api,
          chatId,
          text,
          opts as Parameters<typeof bot.api.sendMessage>[2],
        ),
        getPrimaryChatId: () => primaryChatId,
      });
      startDigestLoop({
        db,
        sendMessage: (chatId, text, opts) => safeSendMessage(bot!.api, chatId, text, opts as never),
        getPrimaryChatId: () => primaryChatId,
      });
      startDailyDigestLoop({
        db,
        sendMessage: (chatId, text, opts) => safeSendMessage(bot!.api, chatId, text, opts as never),
        getPrimaryChatId: () => primaryChatId,
      });
    } else {
      logger.warn({ module: 'publisher' }, 'TELEGRAM_PRIMARY_CHAT_ID not set — publisher disabled');
    }

    startRiotIdTrackerLoop({
      db,
      getAccountByPuuid,
      setCustomTitleInChat: (chatId, telegramId, title) =>
        safeSetCustomTitle(bot!.api, chatId, telegramId, title).then(() => undefined),
      getAllowedChatIds: loadAllowedChatIds,
    });

    startRestrictGraceLoop({
      db,
      getAllowedChatIds: loadAllowedChatIds,
      getBotId: () => bot!.botInfo.id,
      restrictChatMember: (chatId, userId, permissions) =>
        bot!.api.restrictChatMember(chatId, userId, permissions).then(() => undefined),
      getChatAdministrators: (chatId) =>
        bot!.api.getChatAdministrators(chatId),
    });

    startRetryPendingOnboardLoop({
      db,
      validateAccount,
      scanForPuuid,
    });
  }
}

const onboardHandler = makeOnboardHandler({
  db,
  validateAccount,
  scanForPuuid, // wired in #9 (henrik-scanner-loop)
  ...(bot
    ? {
        restrictChatMember: (chatId: number, userId: number, permissions: Parameters<typeof bot.api.restrictChatMember>[2]) =>
          bot!.api.restrictChatMember(chatId, userId, permissions).then(() => undefined),
        getAllowedChatIds: loadAllowedChatIds,
      }
    : {}),
});
const meHandler = makeMeHandler({ db });
app.post('/api/onboard', onboardHandler);
app.get('/api/me', meHandler);


// Serve Vite build static files (dist/web) — API routes above take precedence
app.use('/*', serveStatic({ root: './dist/web' }));

logger.info({ module: 'startup', port: PORT }, 'Server starting');

export default {
  port: PORT,
  fetch: app.fetch,
};
