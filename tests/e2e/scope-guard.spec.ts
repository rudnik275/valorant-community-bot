/**
 * tests/e2e/scope-guard.spec.ts
 *
 * Integration test for the scope-guard middleware.
 * Broader than scope-guard.test.ts — this test wires scopeGuard through a
 * mock grammY context to confirm the full module import chain works and
 * leaveChat is called when the bot is added to an unauthorized chat.
 *
 * These tests do not use a real Bot instance; they construct a minimal
 * context object that satisfies the middleware's type expectations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCache } from '../../src/server/lib/scope.ts';

vi.mock('../../src/server/lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Types & helpers ───────────────────────────────────────────────────────────

type ChatType = 'private' | 'group' | 'supergroup' | 'channel';

interface FakeChat {
  id: number;
  type: ChatType;
  title?: string;
}

interface FakeMyChatMember {
  new_chat_member: {
    user: { id: number };
    status: 'member' | 'administrator' | 'kicked' | 'left';
  };
}

interface FakeApi {
  leaveChat: ReturnType<typeof vi.fn>;
}

interface FakeCtx {
  chat?: FakeChat;
  from?: { id: number };
  me: { id: number };
  api: FakeApi;
  update: {
    my_chat_member?: FakeMyChatMember;
  };
}

const BOT_ID = 7771234;

function makeApi(): FakeApi {
  return { leaveChat: vi.fn().mockResolvedValue(true) };
}

function makeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
  return {
    chat: { id: -100444555666, type: 'supergroup', title: 'Default Group' },
    from: { id: 1234 },
    me: { id: BOT_ID },
    api: makeApi(),
    update: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('e2e: scope-guard middleware', () => {
  const ALLOWED_CHAT_ID = -100111222333;
  const DISALLOWED_CHAT_ID = -100999888777;

  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = String(ALLOWED_CHAT_ID);
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    vi.resetAllMocks();
  });

  // ── Allowed chats ────────────────────────────────────────────────────────

  it('calls next() for an update from an allowed chat', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const ctx = makeCtx({ chat: { id: ALLOWED_CHAT_ID, type: 'supergroup' } });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.api.leaveChat).not.toHaveBeenCalled();
  });

  it('calls next() for private chats (DM) regardless of allowlist', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    // Use a chat ID not in the allowlist
    const ctx = makeCtx({ chat: { id: 12345678, type: 'private' } });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.api.leaveChat).not.toHaveBeenCalled();
  });

  // ── Disallowed chats ─────────────────────────────────────────────────────

  it('drops update (no next()) from a disallowed non-private chat', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const ctx = makeCtx({ chat: { id: DISALLOWED_CHAT_ID, type: 'supergroup', title: 'Bad Group' } });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.api.leaveChat).not.toHaveBeenCalled(); // not a my_chat_member update
  });

  // ── Scope-guard leave on add (the spec's primary e2e requirement) ─────────

  it('calls leaveChat with the correct chatId when bot is added to a disallowed group', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const api = makeApi();
    const ctx = makeCtx({
      chat: { id: DISALLOWED_CHAT_ID, type: 'supergroup', title: 'Unauthorized Group' },
      me: { id: BOT_ID },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: BOT_ID }, status: 'member' },
        },
      },
    });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    expect(api.leaveChat).toHaveBeenCalledOnce();
    expect(api.leaveChat).toHaveBeenCalledWith(DISALLOWED_CHAT_ID);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls leaveChat when bot is promoted to admin in a disallowed group', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const api = makeApi();
    const ctx = makeCtx({
      chat: { id: DISALLOWED_CHAT_ID, type: 'supergroup', title: 'Promoted But Unauth' },
      me: { id: BOT_ID },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: BOT_ID }, status: 'administrator' },
        },
      },
    });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    expect(api.leaveChat).toHaveBeenCalledOnce();
    expect(api.leaveChat).toHaveBeenCalledWith(DISALLOWED_CHAT_ID);
  });

  it('does NOT leave when bot is added to an ALLOWED group (happy path)', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const api = makeApi();
    const ctx = makeCtx({
      chat: { id: ALLOWED_CHAT_ID, type: 'supergroup', title: 'Official Group' },
      me: { id: BOT_ID },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: BOT_ID }, status: 'member' },
        },
      },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(api.leaveChat).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT leave when a non-bot user is added to a disallowed group (wrong user)', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const api = makeApi();
    const ctx = makeCtx({
      chat: { id: DISALLOWED_CHAT_ID, type: 'supergroup' },
      me: { id: BOT_ID },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: 99999 }, status: 'member' }, // different user, not the bot
        },
      },
    });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    // Not the bot being added — leaveChat should NOT be called
    expect(api.leaveChat).not.toHaveBeenCalled();
    // Chat is disallowed, so next NOT called either
    expect(next).not.toHaveBeenCalled();
  });

  // ── Logger verification ──────────────────────────────────────────────────

  it('logs unauthorized_invite_left when leaving an unauthorized chat', async () => {
    const { scopeGuard } = await import('../../src/server/bot/scope-guard.ts');
    const logger = (await import('../../src/server/lib/log.ts')).default;
    const api = makeApi();
    const ctx = makeCtx({
      chat: { id: DISALLOWED_CHAT_ID, type: 'supergroup', title: 'Evil Chat' },
      me: { id: BOT_ID },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: BOT_ID }, status: 'member' },
        },
      },
    });

    await scopeGuard(ctx as never, vi.fn());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'unauthorized_invite_left',
        chat_id: DISALLOWED_CHAT_ID,
      }),
      expect.any(String),
    );
  });
});
