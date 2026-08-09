/**
 * check-fresh-migrate.ts — can the schema still be built from nothing?
 *
 * Migration 0013 rebuilds `detected_events` and drizzle-kit emitted its CHECK
 * qualified with the temp table's own name:
 *
 *   CONSTRAINT "status_check" CHECK("__new_detected_events"."status" IN (...))
 *   ALTER TABLE `__new_detected_events` RENAME TO `detected_events`;
 *
 * Whether that rename survives depends entirely on the SQLite build's
 * `legacy_alter_table` default. With it OFF, SQLite requalifies the expression
 * and the rename works. With it ON, it does not, and the migration dies with
 * `no such column: __new_detected_events.status`.
 *
 * That default is NOT constant across the places this repo runs. A developer
 * Mac's `bun:sqlite` dlopens Apple's system libsqlite3, which defaults it ON —
 * so a blank DB could not be migrated there at all. The container's bundled
 * SQLite defaults it OFF, which is why prod and CI never noticed, and why the
 * first version of this guard passed on the broken chain (issue #343,
 * 2026-08-09). Note this is a pragma default, not a version ordering: the
 * failing build was OLDER than the ones that tolerated it.
 *
 * So the guard forces BOTH settings. A chain that migrates under each of them
 * is portable to any SQLite we could land on, and the bug class is gated
 * deterministically in CI instead of depending on the runner's libsqlite3.
 *
 * Run: `bun run test:migrate-fresh` (CI runs it right after the vitest suite,
 * because vitest goes through better-sqlite3 and never touches this driver).
 */

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'fresh-migrate-'));
let failed = false;

for (const legacyAlterTable of [0, 1]) {
  const label = `legacy_alter_table=${legacyAlterTable}`;
  const sqlite = new Database(join(dir, `fresh-${legacyAlterTable}.db`), { create: true });
  // Same pragmas the app opens with (src/server/db/client.ts), plus the rename
  // mode this guard exists to pin down.
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(`PRAGMA legacy_alter_table=${legacyAlterTable};`);

  try {
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });

    // A rename that silently DROPPED the constraint would still "migrate
    // fine", so prove the rebuilt table actually bites.
    let rejected = false;
    try {
      sqlite.exec(
        `INSERT INTO detected_events (event_type, match_id, payload_json, status)
         VALUES ('probe', 'probe-match', '{}', 'not-a-real-status')`,
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('detected_events.status_check is not enforced after the 0013 rebuild');

    const integrity = sqlite.query('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`integrity_check returned ${integrity.integrity_check}`);
    }

    console.log(`✓ blank database migrates under bun:sqlite, ${label}`);
  } catch (err) {
    failed = true;
    const e = err as { cause?: unknown; message?: string };
    console.error(`✗ blank database FAILED under bun:sqlite, ${label}: ${String(e.cause ?? e.message ?? err)}`);
  } finally {
    sqlite.close();
  }
}

rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
