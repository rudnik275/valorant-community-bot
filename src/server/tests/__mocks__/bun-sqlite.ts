/**
 * Shim for bun:sqlite so Vitest (Node) can run tests that import bun:sqlite.
 * Uses better-sqlite3 which has a compatible API.
 */
import BetterSQLite3 from 'better-sqlite3';

export const Database = BetterSQLite3;
