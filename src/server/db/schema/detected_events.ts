import { integer, text, sqliteTable, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

export const detectedEvents = sqliteTable(
  'detected_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    event_type: text('event_type').notNull(),
    riot_puuid: text('riot_puuid').references(() => users.riot_puuid),
    match_id: text('match_id').notNull(),
    payload_json: text('payload_json').notNull(),
    detected_at: integer('detected_at').notNull().default(sql`(unixepoch() * 1000)`),
    status: text('status').notNull().default('pending'),
    posted_at: integer('posted_at'),
    posted_message_id: integer('posted_message_id'),
  },
  (table) => [
    index('idx_de_status_detected_at').on(table.status, table.detected_at),
    index('idx_de_puuid_detected_at').on(table.riot_puuid, table.detected_at),
    uniqueIndex('idx_de_match_event').on(table.match_id, table.event_type, table.riot_puuid),
    check('status_check', sql`${table.status} IN ('pending','posted','digest-only','silent','opted-out')`),
  ],
);
