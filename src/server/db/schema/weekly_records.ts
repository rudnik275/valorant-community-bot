import { integer, text, sqliteTable, primaryKey } from 'drizzle-orm/sqlite-core';

export const weeklyRecords = sqliteTable(
  'weekly_records',
  {
    record_type: text('record_type').notNull(),
    week_iso: text('week_iso').notNull(),
    riot_puuid: text('riot_puuid').notNull(),
    value: integer('value').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.record_type, table.week_iso] }),
  ],
);
