import { integer, text, sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const digestRuns = sqliteTable('digest_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  week_iso: text('week_iso').notNull(), // e.g. "2026-W19"
  started_at: integer('started_at').notNull().default(sql`(unixepoch() * 1000)`),
  posted_at: integer('posted_at'),
  posted_message_id: integer('posted_message_id'),
  posted_text: text('posted_text'),
}, (table) => [
  uniqueIndex('idx_digest_runs_week_iso').on(table.week_iso),
]);
