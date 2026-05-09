import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCache } from '../lib/scope.ts';

// Mock the logger so test output is clean
vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Inline helper to build a minimal fake grammY context
type FakeApi = {
  leaveChat: ReturnType<typeof vi.fn>;
};

type FakeContext = {
  chat?: { id: number; type: string; title?: string };
  from?: { id: number };
  me: { id: number };
  api: FakeApi;
  update: {
    my_chat_member?: {
      new_chat_member: { user: { id: number }; status: string };
    };
  };
};

function makeCtx(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    chat: { id: -100123, type: 'supergroup', title: 'Test Group' },
    from: { id: 42 },
    me: { id: 999 },
    api: { leaveChat: vi.fn().mockResolvedValue(true) },
    update: {},
    ...overrides,
  };
}

describe('scopeGuard middleware', () => {
  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '-100123,-100456';
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    vi.resetAllMocks();
  });

  it('calls next() for an allowed chat', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    const ctx = makeCtx({ chat: { id: -100123, type: 'supergroup' } });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT call next() for a disallowed chat and logs a warning', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    const logger = (await import('../lib/log.ts')).default;
    const ctx = makeCtx({ chat: { id: -999999, type: 'supergroup', title: 'Evil Group' } });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unauthorized_chat', chat_id: -999999 }),
      expect.any(String),
    );
  });

  it('passes through private chat without checking allowlist', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    // Use a chat ID that is NOT in the allowlist
    const ctx = makeCtx({ chat: { id: 12345, type: 'private' } });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('calls leaveChat when bot is added to a disallowed group via my_chat_member', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    const logger = (await import('../lib/log.ts')).default;
    const api = { leaveChat: vi.fn().mockResolvedValue(true) };
    const ctx = makeCtx({
      chat: { id: -777777, type: 'supergroup', title: 'Unauthorized Group' },
      me: { id: 999 },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: 999 }, status: 'member' },
        },
      },
    });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    expect(api.leaveChat).toHaveBeenCalledWith(-777777);
    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unauthorized_invite_left', chat_id: -777777 }),
      expect.any(String),
    );
  });

  it('does NOT leave chat when bot is added to an allowed group via my_chat_member', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    const api = { leaveChat: vi.fn().mockResolvedValue(true) };
    const ctx = makeCtx({
      chat: { id: -100123, type: 'supergroup', title: 'Official Group' },
      me: { id: 999 },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: 999 }, status: 'administrator' },
        },
      },
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await scopeGuard(ctx as never, next);

    expect(api.leaveChat).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT leave chat on my_chat_member for a different user (not bot)', async () => {
    const { scopeGuard } = await import('./scope-guard.ts');
    const api = { leaveChat: vi.fn().mockResolvedValue(true) };
    const ctx = makeCtx({
      chat: { id: -777777, type: 'supergroup' },
      me: { id: 999 },
      api,
      update: {
        my_chat_member: {
          new_chat_member: { user: { id: 123 }, status: 'member' }, // different user
        },
      },
    });
    const next = vi.fn();

    await scopeGuard(ctx as never, next);

    // Not the bot being added, so leaveChat NOT called; chat is disallowed so next NOT called either
    expect(api.leaveChat).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
