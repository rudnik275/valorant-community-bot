/**
 * listener.test.ts — Unit tests for the lastMessageAt grammY handler.
 *
 * Uses better-sqlite3 (in-memory) + drizzle/better-sqlite3 so Vitest (Node)
 * can run without bun:sqlite. The SQL Drizzle generates is identical for both
 * drivers.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { makeLastMessageHandler } from './listener.ts';
import { users } from '../db/schema/users.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

// The chat ID that isAllowedChat stubs will allow
const ALLOWED_CHAT_ID = -100123;
const BOT_ID = 999;

// Stub isAllowedChat
const isAllowedChat = (id: number) => id === ALLOWED_CHAT_ID;

type FakeContext = {
  from?: { id: number; username?: string; is_bot?: boolean };
  chat?: { id: number; type: string };
  me: { id: number };
  update: {
    message?: object;
    edited_message?: object;
    message_reaction?: object;
  };
};

function makeCtx(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    from: { id: 42, username: 'alice', is_bot: false },
    chat: { id: ALLOWED_CHAT_ID, type: 'supergroup' },
    me: { id: BOT_ID },
    update: { message: {} },
    ...overrides,
  };
}

describe('makeLastMessageHandler', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeAll(() => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = String(ALLOWED_CHAT_ID);
  });

  afterAll(() => {
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
  });

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  it('inserts a new user row on first message (riot_puuid IS NULL, last_message_at set)', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });
    const before = Date.now();

    await handler(makeCtx() as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.riot_puuid).toBeNull();
    expect(row.telegram_username).toBe('alice');
    expect(row.last_message_at).toBeGreaterThanOrEqual(before);
    expect(row.last_message_at).toBeLessThanOrEqual(Date.now());
  });

  it('updates last_message_at on second message but preserves joined_at and riot_puuid', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    // Pre-insert row with known joined_at and riot_puuid
    const knownJoinedAt = Date.now() - 100_000;
    db.insert(users).values({
      telegram_id: 42,
      telegram_username: 'alice',
      riot_puuid: 'puuid-xyz',
      last_message_at: Date.now() - 50_000,
      joined_at: knownJoinedAt,
    }).run();

    const before = Date.now();
    await handler(makeCtx() as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // riot_puuid must be preserved
    expect(row.riot_puuid).toBe('puuid-xyz');

    // joined_at must NOT be overwritten
    expect(row.joined_at).toBe(knownJoinedAt);

    // last_message_at must be updated to around now
    expect(row.last_message_at).toBeGreaterThanOrEqual(before);
    expect(row.last_message_at).toBeLessThanOrEqual(Date.now());
  });

  it('does NOT update last_message_at on edited_message', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ update: { edited_message: {} } }) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(0);
  });

  it('does NOT update last_message_at on message_reaction', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ update: { message_reaction: {} } }) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(0);
  });

  it('ignores messages where from.is_bot is true', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ from: { id: 77, username: 'some_bot', is_bot: true } }) as never);

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  it('ignores messages from the bot itself (from.id === ctx.me.id)', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ from: { id: BOT_ID, username: 'my_bot', is_bot: false } }) as never);

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  it('ignores messages from private chats', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ chat: { id: 12345, type: 'private' } }) as never);

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  it('ignores messages from disallowed chats (defence in depth)', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    await handler(makeCtx({ chat: { id: -999999, type: 'supergroup' } }) as never);

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  // COALESCE preservation tests
  it('preserves existing telegram_username when update delivers null (no username in update)', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    // Pre-insert row with known username
    db.insert(users).values({
      telegram_id: 42,
      telegram_username: 'alice',
    }).run();

    // Simulate update where user has no username (privacy / removed) — omit the field
    await handler(makeCtx({ from: { id: 42, is_bot: false } }) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(1);
    // Known-good username must be preserved
    expect(rows[0]!.telegram_username).toBe('alice');
  });

  it('updates telegram_username when update delivers a non-null value', async () => {
    const handler = makeLastMessageHandler({ db, isAllowedChat });

    // Pre-insert row with old username
    db.insert(users).values({
      telegram_id: 42,
      telegram_username: 'alice_old',
    }).run();

    // Simulate update where user changed their username
    await handler(makeCtx({ from: { id: 42, username: 'alice_new', is_bot: false } }) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 42)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telegram_username).toBe('alice_new');
  });
});
