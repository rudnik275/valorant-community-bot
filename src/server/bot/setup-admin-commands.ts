/**
 * setup-admin-commands.ts — Register the admin command list with Telegram so
 * the "/" quick-pick menu shows them ONLY in the owner's DM, not for anyone
 * else.
 *
 * Uses `setMyCommands` with `BotCommandScopeChat` targeting OWNER_TELEGRAM_ID.
 * Telegram resolves the menu by scope precedence: chat > all-private >
 * default, so a chat-scope list for the owner overrides whatever default
 * list is set (currently empty) without affecting other users.
 *
 * Idempotent — safe to call on every startup. The API is fire-and-forget
 * (errors are logged, not thrown) so a transient Telegram failure doesn't
 * block bot startup.
 */

import type { Bot } from 'grammy';
import { OWNER_TELEGRAM_ID } from './test-commands.ts';
import logger from '../lib/log.ts';

/**
 * The admin command list — appears in the "/" menu only in the owner's DM.
 * Keep in sync with `bot.command(...)` registrations in index.ts.
 */
export const ADMIN_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'congrats', description: 'Поздравить игрока за сегодняшние матчи' },
  { command: 'test_digest', description: 'Превью еженедельного дайджеста' },
  { command: 'test_runtime_events', description: 'Переиграть realtime-события' },
  { command: 'test_daily_ace', description: 'Превью ежедневного дайджеста ейсов' },
];

export async function setupAdminCommandsForOwner(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(ADMIN_COMMANDS as { command: string; description: string }[], {
      scope: { type: 'chat', chat_id: OWNER_TELEGRAM_ID },
    });
    logger.info(
      { module: 'bot', owner_id: OWNER_TELEGRAM_ID, commands: ADMIN_COMMANDS.length },
      'Admin commands registered for owner DM',
    );
  } catch (err) {
    logger.warn(
      { module: 'bot', owner_id: OWNER_TELEGRAM_ID, err },
      'Failed to register admin commands — non-fatal, will retry next startup',
    );
  }
}
