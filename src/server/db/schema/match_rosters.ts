import { integer, text, sqliteTable, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const matchRosters = sqliteTable(
  'match_rosters',
  {
    match_id: text('match_id').notNull(),
    riot_puuid: text('riot_puuid').notNull(),
    team: text('team').notNull(),       // 'Blue' / 'Red' (Henrik team_id)
    name: text('name'),
    tag: text('tag'),
    agent: text('agent'),               // agent played this match (null for pre-#301 rows)
    inserted_at: integer('inserted_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.match_id, table.riot_puuid] }),
    index('idx_match_rosters_puuid').on(table.riot_puuid),
    index('idx_match_rosters_match_team').on(table.match_id, table.team),
  ],
);
