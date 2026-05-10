import { integer, text, sqliteTable, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable(
  'users',
  {
    telegram_id: integer('telegram_id').primaryKey(),
    telegram_username: text('telegram_username'),
    telegram_avatar_file_id: text('telegram_avatar_file_id'),
    telegram_avatar_url: text('telegram_avatar_url'),
    telegram_avatar_fetched_at: integer('telegram_avatar_fetched_at'),
    riot_puuid: text('riot_puuid').unique(),
    riot_name: text('riot_name'),
    riot_tag: text('riot_tag'),
    riot_region: text('riot_region'),
    last_message_at: integer('last_message_at'),
    joined_at: integer('joined_at').notNull().default(sql`(unixepoch() * 1000)`),
    onboarded_at: integer('onboarded_at'),
    riot_lookup_failed_since: integer('riot_lookup_failed_since'),
    current_tier_id: integer('current_tier_id'),
    current_tier_name: text('current_tier_name'),
    peak_tier_id: integer('peak_tier_id'),
    peak_tier_name: text('peak_tier_name'),
    peak_season_short: text('peak_season_short'),
    mmr_fetched_at: integer('mmr_fetched_at'),
  },
  (table) => [
    uniqueIndex('idx_users_riot_puuid').on(table.riot_puuid),
    index('idx_users_last_message_at').on(table.last_message_at),
  ],
);
