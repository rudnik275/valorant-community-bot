import { Hono } from 'hono';
import { Bot } from 'grammy';
import logger from './lib/log.ts';
import healthz from './api/healthz.ts';
import { scopeGuard } from './bot/scope-guard.ts';

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
  // TODO: lastMessageAt listener — added in #6
  bot.start({ drop_pending_updates: true }).catch((err) => {
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

logger.info({ module: 'startup', port: PORT }, 'Server starting');

export default {
  port: PORT,
  fetch: app.fetch,
};
