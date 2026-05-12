import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isOwner, parseDaysArg, makeTestDigestHandler, makeTestRuntimeEventsHandler } from './test-commands.ts';

const originalOwnerId = process.env['TELEGRAM_OWNER_ID'];

beforeEach(() => {
  process.env['TELEGRAM_OWNER_ID'] = '12345';
});

afterEach(() => {
  if (originalOwnerId === undefined) {
    delete process.env['TELEGRAM_OWNER_ID'];
  } else {
    process.env['TELEGRAM_OWNER_ID'] = originalOwnerId;
  }
});

describe('isOwner', () => {
  it('returns true when telegram_id matches TELEGRAM_OWNER_ID', () => {
    expect(isOwner(12345)).toBe(true);
  });

  it('returns false when telegram_id does not match', () => {
    expect(isOwner(99999)).toBe(false);
  });

  it('returns false when telegram_id is undefined', () => {
    expect(isOwner(undefined)).toBe(false);
  });

  it('returns false when TELEGRAM_OWNER_ID env is not set', () => {
    delete process.env['TELEGRAM_OWNER_ID'];
    expect(isOwner(12345)).toBe(false);
  });

  it('returns false when TELEGRAM_OWNER_ID env is empty string', () => {
    process.env['TELEGRAM_OWNER_ID'] = '';
    expect(isOwner(12345)).toBe(false);
  });

  it('returns false when TELEGRAM_OWNER_ID env is non-numeric', () => {
    process.env['TELEGRAM_OWNER_ID'] = 'not-a-number';
    expect(isOwner(12345)).toBe(false);
  });

  it('returns false when TELEGRAM_OWNER_ID is "0"', () => {
    process.env['TELEGRAM_OWNER_ID'] = '0';
    expect(isOwner(0)).toBe(false);
  });
});

describe('parseDaysArg', () => {
  it('returns fallback when text is undefined', () => {
    expect(parseDaysArg(undefined, 7)).toBe(7);
  });

  it('returns fallback when text has no argument', () => {
    expect(parseDaysArg('/test_digest', 7)).toBe(7);
    expect(parseDaysArg('/test_digest   ', 7)).toBe(7);
  });

  it('parses a positive integer argument', () => {
    expect(parseDaysArg('/test_digest 3', 7)).toBe(3);
    expect(parseDaysArg('/test_digest 14', 7)).toBe(14);
  });

  it('strips @botname suffix', () => {
    expect(parseDaysArg('/test_digest@MyBot 5', 7)).toBe(5);
  });

  it('clamps below MIN_DAYS=1 to MIN_DAYS', () => {
    expect(parseDaysArg('/test_digest 0', 7)).toBe(1);
    expect(parseDaysArg('/test_digest -3', 7)).toBe(1);
  });

  it('clamps above MAX_DAYS=30 to MAX_DAYS', () => {
    expect(parseDaysArg('/test_digest 100', 7)).toBe(30);
  });

  it('returns fallback for non-integer values', () => {
    expect(parseDaysArg('/test_digest 7.5', 7)).toBe(7);
    expect(parseDaysArg('/test_digest abc', 7)).toBe(7);
  });

  it('takes only the first positional token', () => {
    expect(parseDaysArg('/test_digest 5 extra ignored', 7)).toBe(5);
  });
});

describe('admin gate (non-owner is silently ignored)', () => {
  function makeMockBot() {
    return {
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    };
  }
  function makeMockDb() {
    return {
      select: vi.fn(),
    };
  }

  it('test_digest handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_digest 3' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_runtime_events handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestRuntimeEventsHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_runtime_events 2' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_digest handler: missing ctx.from is treated as non-owner', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { message: { text: '/test_digest' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
