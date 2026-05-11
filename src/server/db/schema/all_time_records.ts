import { integer, text, real, sqliteTable, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

export const allTimeRecords = sqliteTable(
  'all_time_records',
  {
    record_type: text('record_type').notNull(),
    weapon: text('weapon').notNull().default(''),  // empty string for non-weapon records (simplifies PK)
    riot_puuid: text('riot_puuid').notNull().references(() => users.riot_puuid),
    value: real('value').notNull(),
    match_id: text('match_id').notNull(),
    achieved_at: integer('achieved_at').notNull().default(sql`(unixepoch() * 1000)`),
    prev_value: real('prev_value'),
    prev_puuid: text('prev_puuid'),
  },
  (table) => [
    primaryKey({ columns: [table.record_type, table.weapon] }),
    index('idx_atr_puuid').on(table.riot_puuid),
  ],
);
