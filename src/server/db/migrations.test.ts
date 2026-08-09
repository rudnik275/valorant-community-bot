/**
 * migrations.test.ts — the migration chain must build a schema from nothing,
 * on any SQLite build we could land on.
 *
 * Uses better-sqlite3 (in-memory) so vitest can run it, same shim as
 * schema.test.ts. What differs between the places this repo runs is not the
 * driver but the SQLite build's `legacy_alter_table` default: with it OFF,
 * `ALTER TABLE ... RENAME TO` requalifies column references inside the renamed
 * table's own CHECK expression; with it ON, it does not. drizzle-kit's 12-step
 * rebuild in migration 0013 emitted `CHECK("__new_detected_events"."status" …)`
 * and then renamed that table, so under a default-ON build the whole chain died
 * with `no such column: __new_detected_events.status` — a blank database simply
 * could not be migrated there (issue #343, 2026-08-09). A developer Mac's
 * bun:sqlite links Apple's libsqlite3, which defaults it ON; the container's
 * bundled build defaults it OFF, so prod and CI silently rewrote the constraint
 * and nothing caught it.
 *
 * Pinning the pragma BOTH ways here makes the strict rename semantics the
 * contract, and the static scan below fires at `drizzle-kit generate` time —
 * the next rebuild of `detected_events` or `match_records` would otherwise
 * regenerate the same shape.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

describe('migration chain portability', () => {
  it.each([
    ['legacy_alter_table=OFF (the build the container bundles)', 0],
    ['legacy_alter_table=ON (the build a developer Mac links)', 1],
  ])('migrates a blank database under %s', (_label, legacy) => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=${legacy};`);

    expect(() => migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();

    // The rebuild must land a WORKING check, not merely a surviving one: a
    // rename that silently dropped the constraint would look like a pass.
    expect(() =>
      sqlite.exec(
        `INSERT INTO detected_events (event_type, match_id, payload_json, status)` +
          ` VALUES ('ace','m1','{}','bogus-status')`,
      ),
    ).toThrow(/CHECK constraint failed/);

    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    sqlite.close();
  });

  it('never references a __new_* rebuild table inside an expression', () => {
    // drizzle-kit backticks real identifiers (`__new_detected_events`) and only
    // ever double-quotes expression text, so a double-quoted __new_ is always
    // the generator leaking the temp table's name into an expression that has
    // to outlive the rename.
    const offenders = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) =>
        readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')
          .split('\n')
          .map((text, i) => ({ file: f, line: i + 1, text }))
          .filter(({ text }) => text.includes('"__new_')),
      );

    expect(offenders).toEqual([]);
  });
});
