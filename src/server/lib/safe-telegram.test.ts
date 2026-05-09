import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCache } from './scope.ts';
import { safeSendMessage, UnauthorizedChatError } from './safe-telegram.ts';

vi.mock('./log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('safeSendMessage', () => {
  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '-100123,-100456';
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    vi.resetAllMocks();
  });

  it('calls api.sendMessage for an allowed chatId', async () => {
    const fakeApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

    const result = await safeSendMessage(fakeApi as never, -100123, 'Hello');

    expect(fakeApi.sendMessage).toHaveBeenCalledWith(-100123, 'Hello', undefined);
    expect(result).toEqual({ message_id: 1 });
  });

  it('throws UnauthorizedChatError for a disallowed chatId', async () => {
    const fakeApi = { sendMessage: vi.fn() };

    await expect(safeSendMessage(fakeApi as never, -999999, 'Hello')).rejects.toThrow(
      UnauthorizedChatError,
    );
    expect(fakeApi.sendMessage).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedChatError with the correct chat ID in the message', async () => {
    const fakeApi = { sendMessage: vi.fn() };

    await expect(safeSendMessage(fakeApi as never, -777777, 'Hello')).rejects.toThrow(
      'Chat -777777 is not in the allowed chat list',
    );
  });
});

describe('UnauthorizedChatError', () => {
  it('is an instance of Error', () => {
    const err = new UnauthorizedChatError(-100);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnauthorizedChatError);
    expect(err.name).toBe('UnauthorizedChatError');
  });
});
