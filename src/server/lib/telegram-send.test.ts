import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCache } from './scope.ts';
import {
  send,
  sendExempt,
  sendWithRetryFn,
  UnauthorizedChatError,
  _setSleepFnForTest,
  _resetSleepFnForTest,
} from './telegram-send.ts';

vi.mock('./log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const ALLOWED_CHAT = -100123;
const DISALLOWED_CHAT = -999999;

/** Instant sleep for tests — resolves on next microtask, no real delay. */
const instantSleep = () => Promise.resolve();

describe('telegram-send', () => {
  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = `${ALLOWED_CHAT},-100456`;
    // Patch sleep so retry tests don't take real seconds.
    _setSleepFnForTest(instantSleep);
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    _resetSleepFnForTest();
    vi.resetAllMocks();
  });

  // ---------------------------------------------------------------------------
  // send() — allowlist guard
  // ---------------------------------------------------------------------------

  describe('send', () => {
    it('sends to an allowlisted chat', async () => {
      const fakeApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

      const result = await send(fakeApi as never, ALLOWED_CHAT, 'hello');

      expect(fakeApi.sendMessage).toHaveBeenCalledWith(ALLOWED_CHAT, 'hello', undefined);
      expect(result).toEqual({ message_id: 1 });
    });

    it('throws UnauthorizedChatError for a non-allowlisted chat without calling the API', async () => {
      const fakeApi = { sendMessage: vi.fn() };

      await expect(send(fakeApi as never, DISALLOWED_CHAT, 'hello')).rejects.toThrow(
        UnauthorizedChatError,
      );
      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedChatError with correct message', async () => {
      const fakeApi = { sendMessage: vi.fn() };

      await expect(send(fakeApi as never, DISALLOWED_CHAT, 'hello')).rejects.toThrow(
        `Chat ${DISALLOWED_CHAT} is not in the allowed chat list`,
      );
    });

    it('retries once on 429 and succeeds', async () => {
      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fakeApi = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(retryAfterError)
          .mockResolvedValueOnce({ message_id: 42 }),
      };

      const result = await send(fakeApi as never, ALLOWED_CHAT, 'hi');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 42 });
    });

    it('retries once on 5xx and succeeds', async () => {
      const transient500 = Object.assign(new Error('Internal Server Error'), { error_code: 500 });
      const fakeApi = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(transient500)
          .mockResolvedValueOnce({ message_id: 7 }),
      };

      const result = await send(fakeApi as never, ALLOWED_CHAT, 'hi');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 7 });
    });

    it('retries once on network error and succeeds', async () => {
      // No error_code, message matches /network/i
      const networkErr = new Error('network timeout');
      const fakeApi = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(networkErr)
          .mockResolvedValueOnce({ message_id: 55 }),
      };

      const result = await send(fakeApi as never, ALLOWED_CHAT, 'hi');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 55 });
    });

    it('does NOT retry on durable 400 error', async () => {
      const durable400 = Object.assign(new Error('Bad Request: chat not found'), { error_code: 400 });
      const fakeApi = {
        sendMessage: vi.fn().mockRejectedValue(durable400),
      };

      await expect(send(fakeApi as never, ALLOWED_CHAT, 'hi')).rejects.toThrow('chat not found');
      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('throws after both attempts fail on 429', async () => {
      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fakeApi = {
        sendMessage: vi.fn().mockRejectedValue(retryAfterError),
      };

      await expect(send(fakeApi as never, ALLOWED_CHAT, 'hi')).rejects.toThrow('429');
      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // sendExempt() — guard bypass for owner-DM / primary-chat
  // ---------------------------------------------------------------------------

  describe('sendExempt', () => {
    it('sends to a non-allowlisted chat without throwing (exemption bypasses guard)', async () => {
      const fakeApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };

      // DISALLOWED_CHAT would fail with send(), but sendExempt bypasses the guard.
      const result = await sendExempt(fakeApi as never, DISALLOWED_CHAT, 'owner DM');

      expect(fakeApi.sendMessage).toHaveBeenCalledWith(DISALLOWED_CHAT, 'owner DM', undefined);
      expect(result).toEqual({ message_id: 99 });
    });

    it('also sends to an allowlisted chat without issue', async () => {
      const fakeApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 5 }) };

      const result = await sendExempt(fakeApi as never, ALLOWED_CHAT, 'primary chat post');

      expect(result).toEqual({ message_id: 5 });
    });

    it('still retries on 429 (retry policy applies to exempt sends too)', async () => {
      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fakeApi = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(retryAfterError)
          .mockResolvedValueOnce({ message_id: 3 }),
      };

      const result = await sendExempt(fakeApi as never, DISALLOWED_CHAT, 'hi');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 3 });
    });
  });

  // ---------------------------------------------------------------------------
  // sendWithRetryFn() — injectable fn wrapper (publisher/loop pattern)
  // ---------------------------------------------------------------------------

  describe('sendWithRetryFn', () => {
    it('calls the injected fn and returns the result', async () => {
      const fn = vi.fn().mockResolvedValue({ message_id: 11 });

      const result = await sendWithRetryFn(fn, ALLOWED_CHAT, 'text', { parse_mode: 'HTML' });

      expect(fn).toHaveBeenCalledWith(ALLOWED_CHAT, 'text', { parse_mode: 'HTML' });
      expect(result).toEqual({ message_id: 11 });
    });

    it('retries once on 429 with retry_after backoff', async () => {
      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 2 },
      });
      const fn = vi.fn()
        .mockRejectedValueOnce(retryAfterError)
        .mockResolvedValueOnce({ message_id: 50 });

      const result = await sendWithRetryFn(fn, ALLOWED_CHAT, 'msg');

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 50 });
    });

    it('retries once on 5xx with 2s backoff', async () => {
      const transient500 = Object.assign(new Error('Internal Server Error'), { error_code: 500 });
      const fn = vi.fn()
        .mockRejectedValueOnce(transient500)
        .mockResolvedValueOnce({ message_id: 88 });

      const result = await sendWithRetryFn(fn, ALLOWED_CHAT, 'msg');

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 88 });
    });

    it('does NOT retry on durable 400 — throws immediately', async () => {
      const durable400 = Object.assign(new Error('Bad Request: chat not found'), { error_code: 400 });
      const fn = vi.fn().mockRejectedValue(durable400);

      await expect(sendWithRetryFn(fn, ALLOWED_CHAT, 'msg')).rejects.toThrow('chat not found');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws after both 429 attempts fail', async () => {
      const retryAfterError = Object.assign(new Error('429 Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fn = vi.fn().mockRejectedValue(retryAfterError);

      await expect(sendWithRetryFn(fn, ALLOWED_CHAT, 'msg')).rejects.toThrow('429');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // UnauthorizedChatError
  // ---------------------------------------------------------------------------

  describe('UnauthorizedChatError', () => {
    it('is an instance of Error', () => {
      const err = new UnauthorizedChatError(-100);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(UnauthorizedChatError);
      expect(err.name).toBe('UnauthorizedChatError');
    });

    it('includes the chat ID in the message', () => {
      const err = new UnauthorizedChatError(-777777);
      expect(err.message).toBe('Chat -777777 is not in the allowed chat list');
    });
  });
});
