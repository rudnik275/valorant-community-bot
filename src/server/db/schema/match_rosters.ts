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
    // Per-participant match stats — needed for the full-roster rich tables of
    // the #315 "trio" events (giant_slayer / match_comeback / community_clash).
    // All nullable: rows written before #315 (and any match Henrik omits the
    // field for) have null, which the rich renderer treats as "incomplete data"
    // and falls back to the legacy plain template.
    tier: text('tier'),                 // rank in THIS match, e.g. "Diamond 2" (null pre-#315)
    kills: integer('kills'),            // kills in this match (null pre-#315)
    deaths: integer('deaths'),          // deaths in this match (null pre-#315)
    inserted_at: integer('inserted_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.match_id, table.riot_puuid] }),
    index('idx_match_rosters_puuid').on(table.riot_puuid),
    index('idx_match_rosters_match_team').on(table.match_id, table.team),
  ],
);
