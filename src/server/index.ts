import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { Bot } from 'grammy';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import logger from './lib/log.ts';
import { db } from './db/client.ts';
import healthz from './api/healthz.ts';
import { scopeGuard } from './bot/scope-guard.ts';
import { makeLastMessageHandler } from './bot/listener.ts';
import { isAllowedChat } from './lib/scope.ts';
import { makeAuthMiddleware } from './api/auth.ts';
import { makeMembersHandler } from './api/members.ts';
import { makeOnboardHandler } from './api/onboard.ts';
import { makeMeHandler } from './api/me.ts';
import { makeSettingsHandlers } from './api/settings.ts';
import { verifyInitData } from './lib/init-data.ts';
import { makeAvatarCache } from './lib/telegram-avatar.ts';
import { validateAccount } from './lib/henrik.ts';
import { loadAllowedChatIds } from './lib/scope.ts';

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
  const lastMessageHandler = makeLastMessageHandler({ db, isAllowedChat });
  bot.on('message', lastMessageHandler);
  bot.on('edited_message', lastMessageHandler);
  bot.on('message_reaction', lastMessageHandler);
  bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message', 'message_reaction', 'my_chat_member'],
  }).catch((err) => {
    logger.error({ module: 'bot', err }, 'grammY bot failed to start');
  });
  logger.info({ module: 'bot' }, 'Telegram bot started (long-polling)');
} else {
  logger.warn({ module: 'bot' }, 'TELEGRAM_BOT_TOKEN not set — bot disabled (dev mode)');
}

// TODO: scanner — start scan-tick croner job here (#6)
// TODO: publisher — start publisher-tick croner job here (#9)
// TODO: digest — schedule weekly digest here (#11)

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
} catch (err) {
  logger.error({ module: 'startup', err }, 'DB migration failed — exiting');
  process.exit(1);
}

// API middleware + routes
const currentBotToken = botToken ?? '';
const authMiddleware = makeAuthMiddleware({
  verify: (raw) => verifyInitData(raw, currentBotToken),
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

const onboardHandler = makeOnboardHandler({
  db,
  validateAccount,
  scanForPuuid: undefined, // wired in #9 (henrik-scanner-loop)
  botApi: bot?.api,
  getAllowedChatIds: loadAllowedChatIds,
});
const meHandler = makeMeHandler({ db });
app.post('/api/onboard', onboardHandler);
app.get('/api/me', meHandler);

const settingsHandlers = makeSettingsHandlers({ db });
app.get('/api/me/settings', settingsHandlers.getSettings);
app.patch('/api/me/settings', settingsHandlers.patchSettings);

// Serve Vite build static files (dist/web) — API routes above take precedence
app.use('/*', serveStatic({ root: './dist/web' }));

logger.info({ module: 'startup', port: PORT }, 'Server starting');

export default {
  port: PORT,
  fetch: app.fetch,
};
