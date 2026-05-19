import { integer, text, sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const digestRuns = sqliteTable('digest_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  week_iso: text('week_iso').notNull(), // e.g. "2026-W19"
  started_at: integer('started_at').notNull().default(sql`(unixepoch() * 1000)`),
  posted_at: integer('posted_at'),
  posted_message_id: integer('posted_message_id'),
  posted_text: text('posted_text'),
  // ─── Two-phase weekly promo image (#227) ──────────────────────────────────
  // The Fri 18:45 "prepare" tick builds the digest once and stashes the text
  // here so the Fri 19:00 "publish" tick posts the *exact same* text the image
  // was generated from. All nullable: existing [silent-period]/[no_content]
  // marker rows and daily semantics stay valid; the image is best-effort, so
  // a prepared row with story_image_path = NULL is normal (image generation
  // failed / no key / no reference PNG — digest still posts text-only).
  prepared_text: text('prepared_text'),
  prepared_top_agent: text('prepared_top_agent'),
  prepared_top_map: text('prepared_top_map'),
  story_image_path: text('story_image_path'),
}, (table) => [
  uniqueIndex('idx_digest_runs_week_iso').on(table.week_iso),
]);
