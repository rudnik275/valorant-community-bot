/**
 * chat-member-listener.test.ts — Unit tests for the chat_member grammY handler.
 *
 * Uses better-sqlite3 (in-memory) + drizzle/better-sqlite3 so Vitest (Node)
 * can run without bun:sqlite. The SQL Drizzle generates is identical for both
 * drivers.
 *
 * 9 test cases per issue #114 spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { makeChatMemberListener } from './chat-member-listener.ts';
import { users } from '../db/schema/users.ts';
import { READONLY_PERMISSIONS } from '../cron/restrict-grace.ts';
import logger from '../lib/log.ts';

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

const ALLOWED_CHAT_ID = -100456;
const OTHER_CHAT_ID = -100789;

const isAllowedChat = (id: number) => id === ALLOWED_CHAT_ID;

type FakeUser = {
  id: number;
  username?: string;
  is_bot?: boolean;
  first_name?: string;
};

type FakeChatMemberUpdate = {
  chat: { id: number };
  new_chat_member: {
    user: FakeUser;
    status: string;
    is_member?: boolean;
  };
};

type FakeContext = {
  update: {
    chat_member?: FakeChatMemberUpdate;
  };
};

function makeCtx(chatMember: FakeChatMemberUpdate): FakeContext {
  return {
    update: { chat_member: chatMember },
  };
}

function makeChatMember(
  userId: number,
  status: string,
  opts: { username?: string; is_bot?: boolean; is_member?: boolean; chatId?: number } = {},
): FakeChatMemberUpdate {
  return {
    chat: { id: opts.chatId ?? ALLOWED_CHAT_ID },
    new_chat_member: {
      user: {
        id: userId,
        username: opts.username ?? `user_${userId}`,
        is_bot: opts.is_bot ?? false,
        first_name: 'Test',
      },
      status,
      ...(opts.is_member !== undefined ? { is_member: opts.is_member } : {}),
    },
  };
}

describe('makeChatMemberListener', () => {
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

  // Case 1: status=member, user new → row created
  it('status=member, new user → creates row with telegram_id and telegram_username', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    await handler(makeCtx(makeChatMember(101, 'member', { username: 'alice' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 101)).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.telegram_id).toBe(101);
    expect(row.telegram_username).toBe('alice');
    expect(row.joined_at).toBeGreaterThan(0);
  });

  // Case 2: status=member, user already in DB with riot_puuid → UPSERT keeps riot_puuid
  it('status=member, existing user with riot_puuid → keeps riot_puuid, only updates username', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    // Pre-insert row with riot_puuid
    db.insert(users).values({
      telegram_id: 102,
      telegram_username: 'bob_old',
      riot_puuid: 'puuid-abc',
    }).run();

    await handler(makeCtx(makeChatMember(102, 'member', { username: 'bob_new' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 102)).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.riot_puuid).toBe('puuid-abc');
    expect(row.telegram_username).toBe('bob_new');
  });

  // Case 3: status=administrator (promote) → UPSERT, no destructive change
  it('status=administrator → upserts row, no destructive change', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    // Pre-insert row with riot_puuid
    db.insert(users).values({
      telegram_id: 103,
      telegram_username: 'carol',
      riot_puuid: 'puuid-carol',
    }).run();

    await handler(makeCtx(makeChatMember(103, 'administrator', { username: 'carol' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 103)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.riot_puuid).toBe('puuid-carol');
  });

  // Case 4: status=left, user in DB → row deleted
  it('status=left, user in DB → row deleted', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    db.insert(users).values({ telegram_id: 104, telegram_username: 'dave' }).run();

    await handler(makeCtx(makeChatMember(104, 'left', { username: 'dave' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 104)).all();
    expect(rows).toHaveLength(0);
  });

  // Case 5: status=kicked, user in DB with riot_puuid → row deleted
  it('status=kicked, user in DB with riot_puuid → row deleted', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    db.insert(users).values({
      telegram_id: 105,
      telegram_username: 'eve',
      riot_puuid: 'puuid-eve',
    }).run();

    await handler(makeCtx(makeChatMember(105, 'kicked', { username: 'eve' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 105)).all();
    expect(rows).toHaveLength(0);
  });

  // Case 6: status=restricted, is_member=true → treated as IN
  it('status=restricted, is_member=true → upserts row (treated as IN)', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    await handler(
      makeCtx(makeChatMember(106, 'restricted', { username: 'frank', is_member: true })) as never,
    );

    const rows = db.select().from(users).where(eq(users.telegram_id, 106)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telegram_username).toBe('frank');
  });

  // Case 7: status=restricted, is_member=false → treated as OUT
  it('status=restricted, is_member=false → deletes row (treated as OUT)', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    db.insert(users).values({ telegram_id: 107, telegram_username: 'grace' }).run();

    await handler(
      makeCtx(makeChatMember(107, 'restricted', { username: 'grace', is_member: false })) as never,
    );

    const rows = db.select().from(users).where(eq(users.telegram_id, 107)).all();
    expect(rows).toHaveLength(0);
  });

  // Case 8: is_bot=true → ignored regardless of status
  it('is_bot=true → ignored regardless of status', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    await handler(
      makeCtx(makeChatMember(108, 'member', { username: 'some_bot', is_bot: true })) as never,
    );

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  // Case 9: chat.id not in allowed list → ignored
  it('chat.id not in allowed list → ignored', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    await handler(
      makeCtx(makeChatMember(109, 'member', { username: 'heidi', chatId: OTHER_CHAT_ID })) as never,
    );

    const rows = db.select().from(users).all();
    expect(rows).toHaveLength(0);
  });

  // COALESCE preservation tests
  it('preserves existing telegram_username when join update delivers no username', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    // Pre-insert row with known username
    db.insert(users).values({
      telegram_id: 110,
      telegram_username: 'ivan',
      riot_puuid: 'puuid-ivan',
    }).run();

    // Simulate join update where Telegram omits username (privacy setting)
    const update = makeChatMember(110, 'member');
    // Explicitly delete username so it's absent from the update (not just undefined)
    delete (update.new_chat_member.user as Partial<FakeUser>).username;

    await handler(makeCtx(update) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 110)).all();
    expect(rows).toHaveLength(1);
    // Known-good username must be preserved
    expect(rows[0]!.telegram_username).toBe('ivan');
    expect(rows[0]!.riot_puuid).toBe('puuid-ivan');
  });

  it('updates telegram_username when join update delivers a non-null value', async () => {
    const handler = makeChatMemberListener({ db, isAllowedChat });

    // Pre-insert row with old username
    db.insert(users).values({
      telegram_id: 111,
      telegram_username: 'judy_old',
    }).run();

    await handler(makeCtx(makeChatMember(111, 'member', { username: 'judy_new' })) as never);

    const rows = db.select().from(users).where(eq(users.telegram_id, 111)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telegram_username).toBe('judy_new');
  });

  // ── Nick-gate: restrict fresh joiners without a nick on join ──────────────────
  describe('on-join nick-gate restriction', () => {
    function makeRestrictDeps(
      database: typeof db,
      overrides: {
        restrictChatMember?: ReturnType<typeof vi.fn>;
        getChatAdministrators?: ReturnType<typeof vi.fn>;
      } = {},
    ) {
      return {
        db: database,
        isAllowedChat,
        restrictChatMember: overrides.restrictChatMember ?? vi.fn().mockResolvedValue(undefined),
        getChatAdministrators: overrides.getChatAdministrators ?? vi.fn().mockResolvedValue([]),
      };
    }

    it('fresh join with no nick → restricted read-only, restricted_at set', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const handler = makeChatMemberListener(makeRestrictDeps(db, { restrictChatMember }));

      await handler(makeCtx(makeChatMember(201, 'member', { username: 'newbie' })) as never);

      expect(restrictChatMember).toHaveBeenCalledOnce();
      expect(restrictChatMember).toHaveBeenCalledWith(ALLOWED_CHAT_ID, 201, READONLY_PERMISSIONS);

      const row = db.select().from(users).where(eq(users.telegram_id, 201)).all()[0]!;
      expect(row.restricted_at).toBeGreaterThan(0);
    });

    it('fresh join of a user who already entered a nick → NOT restricted', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const handler = makeChatMemberListener(makeRestrictDeps(db, { restrictChatMember }));

      // Returning member who previously entered a nick (riot_name set, account stale → no puuid)
      db.insert(users).values({
        telegram_id: 202,
        telegram_username: 'veteran',
        riot_name: 'OldTimer',
        riot_tag: 'EU1',
      }).run();

      await handler(makeCtx(makeChatMember(202, 'member', { username: 'veteran' })) as never);

      expect(restrictChatMember).not.toHaveBeenCalled();
      const row = db.select().from(users).where(eq(users.telegram_id, 202)).all()[0]!;
      expect(row.restricted_at).toBeNull();
    });

    it('admin who joins/updates as member → NOT restricted', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const getChatAdministrators = vi.fn().mockResolvedValue([{ user: { id: 203 } }]);
      const handler = makeChatMemberListener(
        makeRestrictDeps(db, { restrictChatMember, getChatAdministrators }),
      );

      await handler(makeCtx(makeChatMember(203, 'member', { username: 'boss' })) as never);

      expect(restrictChatMember).not.toHaveBeenCalled();
      const row = db.select().from(users).where(eq(users.telegram_id, 203)).all()[0]!;
      expect(row.restricted_at).toBeNull();
    });

    it('status=restricted echo (our own restrict) → does NOT re-restrict (no loop)', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const handler = makeChatMemberListener(makeRestrictDeps(db, { restrictChatMember }));

      await handler(
        makeCtx(makeChatMember(204, 'restricted', { username: 'muted', is_member: true })) as never,
      );

      expect(restrictChatMember).not.toHaveBeenCalled();
    });

    it('already-restricted user re-emitting member status → NOT re-restricted', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const handler = makeChatMemberListener(makeRestrictDeps(db, { restrictChatMember }));

      db.insert(users).values({
        telegram_id: 205,
        telegram_username: 'already',
        restricted_at: 1_700_000_000_000,
      }).run();

      await handler(makeCtx(makeChatMember(205, 'member', { username: 'already' })) as never);

      expect(restrictChatMember).not.toHaveBeenCalled();
    });

    it('restrictChatMember fails → restricted_at NOT set, no crash, warning logged', async () => {
      const restrictChatMember = vi.fn().mockRejectedValue(new Error('not enough rights'));
      const handler = makeChatMemberListener(makeRestrictDeps(db, { restrictChatMember }));

      await expect(
        handler(makeCtx(makeChatMember(206, 'member', { username: 'nope' })) as never),
      ).resolves.toBeUndefined();

      const row = db.select().from(users).where(eq(users.telegram_id, 206)).all()[0]!;
      expect(row.restricted_at).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'restrict_on_join_failed', user_id: 206 }),
        expect.stringContaining('restrictChatMember failed on join'),
      );
    });

    it('getChatAdministrators fails → restriction skipped, no restricted_at, no crash', async () => {
      const restrictChatMember = vi.fn().mockResolvedValue(undefined);
      const getChatAdministrators = vi.fn().mockRejectedValue(new Error('Forbidden'));
      const handler = makeChatMemberListener(
        makeRestrictDeps(db, { restrictChatMember, getChatAdministrators }),
      );

      await expect(
        handler(makeCtx(makeChatMember(207, 'member', { username: 'unknown' })) as never),
      ).resolves.toBeUndefined();

      expect(restrictChatMember).not.toHaveBeenCalled();
      const row = db.select().from(users).where(eq(users.telegram_id, 207)).all()[0]!;
      expect(row.restricted_at).toBeNull();
    });

    it('deps absent (no restrictChatMember) → membership tracked, no restriction attempted', async () => {
      const handler = makeChatMemberListener({ db, isAllowedChat });

      await handler(makeCtx(makeChatMember(208, 'member', { username: 'plain' })) as never);

      const row = db.select().from(users).where(eq(users.telegram_id, 208)).all()[0]!;
      expect(row.telegram_id).toBe(208);
      expect(row.restricted_at).toBeNull();
    });
  });
});
