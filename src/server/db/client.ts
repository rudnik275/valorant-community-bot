import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';

const sqlite = new Database(process.env['DATABASE_FILE'] ?? './data/data.db', { create: true });
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
export const db = drizzle(sqlite);
