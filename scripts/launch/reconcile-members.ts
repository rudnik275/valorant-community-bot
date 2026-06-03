// One-shot membership reconciliation script.
// Compares every member row in the DB against actual Telegram group membership
// using getChatMember, and reports (or purges) anyone Telegram confirms has left.
//
// Usage (dry-run — report only, no deletions):
//   with-secrets bun run scripts/launch/reconcile-members.ts
//
// Usage (apply — purge confirmed-departed players and rebuild records):
//   with-secrets bun run scripts/launch/reconcile-members.ts --apply
//
// IMPORTANT: Run a DB backup before the first --apply run.

import { Bot } from 'grammy';
import { db } from '../../src/server/db/client.ts';
import { users } from '../../src/server/db/schema/users.ts';
import { loadAllowedChatIds } from '../../src/server/lib/scope.ts';
import { runReconcileMembershipTick } from '../../src/server/cron/reconcile-membership.ts';
import { rebuildAllRecords } from '../../src/server/publisher/records-rebuild.ts';
import { eq } from 'drizzle-orm';

const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN not set. Run via: with-secrets bun run scripts/launch/reconcile-members.ts');
  process.exit(1);
}

const applyMode = process.argv.includes('--apply');

console.log(`\n=== reconcile-members.ts ===`);
console.log(`Mode: ${applyMode ? 'APPLY (purge + rebuild)' : 'DRY-RUN (report only)'}`);
console.log('');

const bot = new Bot(token);
await bot.init();
console.log(`Bot: @${bot.botInfo.username} (id=${bot.botInfo.id})`);

const chatIds = loadAllowedChatIds();
console.log(`Allowed chats: ${[...chatIds].join(', ')}`);
console.log('');

const result = await runReconcileMembershipTick({
  db,
  getAllowedChatIds: loadAllowedChatIds,
  getBotId: () => bot.botInfo.id,
  getChatMember: (chatId, userId) => bot.api.getChatMember(chatId, userId),
  rebuildRecords: rebuildAllRecords,
  dryRun: !applyMode,
});

if (result.departed.length === 0) {
  console.log('No departed members found. Member list is clean.');
} else {
  console.log(`Departed members (${result.departed.length}):`);
  for (const telegramId of result.departed) {
    const rows = await db
      .select({ riot_name: users.riot_name, riot_tag: users.riot_tag, telegram_username: users.telegram_username })
      .from(users)
      .where(eq(users.telegram_id, telegramId));
    const row = rows[0];
    const riotId = row?.riot_name && row?.riot_tag
      ? `${row.riot_name}#${row.riot_tag}`
      : '(not linked)';
    const tgUsername = row?.telegram_username ? `@${row.telegram_username}` : '(no username)';
    console.log(`  telegram_id=${telegramId}  ${tgUsername}  ${riotId}`);
  }
}

console.log('');

if (applyMode) {
  if (result.purged.length > 0) {
    console.log(`Purged ${result.purged.length} player(s): [${result.purged.join(', ')}]`);
    console.log('Records rebuilt from surviving match_records.');
  } else {
    console.log('No players purged.');
  }
} else {
  if (result.departed.length > 0) {
    console.log(`Re-run with --apply to purge these ${result.departed.length} player(s) and rebuild records.`);
  }
}

console.log('');
process.exit(0);
