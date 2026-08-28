/**
 * rich-templates.event.test.ts — `renderRichEvent`: the layer that maps a
 * stored event payload onto the rich template context, exercised against REAL
 * in-memory SQLite + migrations (project rule: never mock the DB).
 *
 * The pure renderer is covered in rich-templates.test.ts; this file exists
 * because the regression it guards lived HERE, not in the renderer: the #315
 * rich rewrite read `winner_team_id` / `team_scores` off the payload for
 * community_clash but nothing at all for match_comeback, so the comeback
 * message silently lost the «с какого счёта отыгрались» the legacy plain
 * template always had (owner, 2026-08-28).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { matchRosters } from '../db/schema/match_rosters.ts';
import type { SqliteDb } from '../db/queries.ts';
import { renderRichEvent } from './rich-templates.ts';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');
const MATCH_ID = 'm-comeback';

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as SqliteDb, sqlite };
}

/** Minimal complete 1v1 roster — two teams, every row has tier/kills/deaths. */
async function seedRoster(db: SqliteDb) {
  await db.insert(matchRosters).values([
    { match_id: MATCH_ID, riot_puuid: 'p1', team: 'Blue', name: 'Alice', tag: 'AAA', agent: 'Jett', tier: 'Diamond 2', kills: 21, deaths: 14 },
    { match_id: MATCH_ID, riot_puuid: 'p2', team: 'Red', name: 'Foe', tag: 'ENE', agent: 'Sova', tier: 'Diamond 1', kills: 14, deaths: 21 },
  ]);
}

/** The payload matchComebackDetector actually writes. */
function comebackPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_deficit: 8,
    deficit_score_player: 3,
    deficit_score_opponent: 11,
    final_score_player: 13,
    final_score_opponent: 11,
    community_players: [{ puuid: 'p1', name: 'Alice', tag: 'AAA', agent: 'Jett' }],
    ...over,
  };
}

describe('renderRichEvent — match_comeback payload wiring', () => {
  let db: SqliteDb;
  let sqlite: Database.Database;

  beforeEach(async () => {
    ({ db, sqlite } = makeTestDb());
    await seedRoster(db);
  });
  afterEach(() => sqlite.close());

  it('carries the detector scores into the description line', async () => {
    const html = await renderRichEvent(db, 'match_comeback', comebackPayload(), {
      match_id: MATCH_ID,
      map: 'Abyss',
    });
    expect(html).toContain('Отыгрались с 3:11 до 13:11 и вырвали победу.');
  });

  it('falls back to the generic sentence when the payload has no scores', async () => {
    const html = await renderRichEvent(db, 'match_comeback', { community_players: [] }, {
      match_id: MATCH_ID,
      map: 'Abyss',
    });
    expect(html).toContain('Отыгрались из глубокого отставания и вырвали победу.');
  });

  it('falls back when the scores are only partly present (no «3:?» line)', async () => {
    const partial = comebackPayload();
    delete partial['final_score_opponent'];
    const html = await renderRichEvent(db, 'match_comeback', partial, {
      match_id: MATCH_ID,
      map: 'Abyss',
    });
    expect(html).toContain('Отыгрались из глубокого отставания и вырвали победу.');
    expect(html).not.toContain('3:11');
  });

  it('ignores non-numeric score values rather than printing them', async () => {
    const html = await renderRichEvent(db, 'match_comeback', comebackPayload({ deficit_score_player: '3' }), {
      match_id: MATCH_ID,
      map: 'Abyss',
    });
    expect(html).toContain('Отыгрались из глубокого отставания и вырвали победу.');
  });
});
