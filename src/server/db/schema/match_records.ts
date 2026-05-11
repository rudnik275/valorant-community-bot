import { integer, text, sqliteTable, index, check, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

export const matchRecords = sqliteTable(
  'match_records',
  {
    riot_puuid: text('riot_puuid').references(() => users.riot_puuid, { onDelete: 'set null' }),
    match_id: text('match_id').notNull(),
    started_at: integer('started_at').notNull(),
    map: text('map').notNull(),
    agent: text('agent').notNull(),
    kills: integer('kills').notNull(),
    deaths: integer('deaths').notNull(),
    assists: integer('assists').notNull(),
    result: text('result').notNull(),
    rounds_played: integer('rounds_played').notNull(),
    rank_before: text('rank_before'),
    rank_after: text('rank_after'),
    enemy_avg_rank: text('enemy_avg_rank'),
    fall_damage_kills: integer('fall_damage_kills').notNull().default(0),
    kill_events_compact: text('kill_events_compact').notNull(),
    rounds_compact: text('rounds_compact'),
    score: integer('score'),
    headshots: integer('headshots'),
    bodyshots: integer('bodyshots'),
    legshots: integer('legshots'),
    damage_dealt: integer('damage_dealt'),
    damage_received: integer('damage_received'),
    team_rounds_won: integer('team_rounds_won'),
    team_rounds_lost: integer('team_rounds_lost'),
    game_length_ms: integer('game_length_ms'),
    is_match_mvp: integer('is_match_mvp'),
    inserted_at: integer('inserted_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    primaryKey({ columns: [table.riot_puuid, table.match_id] }),
    index('idx_match_records_puuid_started_at').on(table.riot_puuid, table.started_at),
    index('idx_match_records_inserted_at').on(table.inserted_at),
    check('result_check', sql`${table.result} IN ('win','loss','draw')`),
  ],
);
