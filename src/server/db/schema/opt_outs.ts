import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

export const optOuts = sqliteTable('opt_outs', {
  telegram_id: integer('telegram_id')
    .primaryKey()
    .references(() => users.telegram_id, { onDelete: 'cascade' }),
  chat_realtime_disabled: integer('chat_realtime_disabled').notNull().default(0),
  updated_at: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
});
