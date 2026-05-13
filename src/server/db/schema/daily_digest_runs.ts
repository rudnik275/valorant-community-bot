import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const dailyDigestRuns = sqliteTable(
  'daily_digest_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    run_date: text('run_date').notNull(), // Kyiv calendar date, YYYY-MM-DD
    started_at: integer('started_at').notNull(), // ms epoch
    posted_at: integer('posted_at'), // ms epoch, null when 0 aces
    posted_message_id: integer('posted_message_id'), // null when 0 aces
    posted_text: text('posted_text'), // null when 0 aces
    included_event_ids: text('included_event_ids').notNull().default('[]'), // JSON array
  },
  (table) => [
    uniqueIndex('idx_daily_digest_runs_run_date').on(table.run_date),
  ],
);
