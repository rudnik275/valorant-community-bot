import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetCache } from './scope.ts';
import {
  send,
  safeSendMessage,
  sendExempt,
  sendWithRetryFn,
  classifySendFailure,
  isAmbiguousSendFailure,
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

    it('does NOT retry a 5xx — Telegram may have queued the message before it broke', async () => {
      // A 5xx means Telegram's own backend failed mid-request, so the message
      // may already be in the chat. Sending it again is how the group ends up
      // reading the same thing twice (owner, 2026-08-09).
      const server500 = Object.assign(new Error('Internal Server Error'), { error_code: 500 });
      const fakeApi = { sendMessage: vi.fn().mockRejectedValue(server500) };

      await expect(send(fakeApi as never, ALLOWED_CHAT, 'hi')).rejects.toThrow('Internal Server Error');
      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a network error — the answer was lost, not the message', async () => {
      const networkErr = new Error('network timeout');
      const fakeApi = { sendMessage: vi.fn().mockRejectedValue(networkErr) };

      await expect(send(fakeApi as never, ALLOWED_CHAT, 'hi')).rejects.toThrow('network timeout');
      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('still retries a 429 — Telegram answered, and said not yet', async () => {
      const rateLimited = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fakeApi = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(rateLimited)
          .mockResolvedValueOnce({ message_id: 7 }),
      };

      const result = await send(fakeApi as never, ALLOWED_CHAT, 'hi');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ message_id: 7 });
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

    it('does NOT retry a 5xx — the injected sender may already have delivered it', async () => {
      const server500 = Object.assign(new Error('Internal Server Error'), { error_code: 500 });
      const fn = vi.fn().mockRejectedValue(server500);

      await expect(sendWithRetryFn(fn, ALLOWED_CHAT, 'msg')).rejects.toThrow('Internal Server Error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('still retries a 429 with its retry_after backoff', async () => {
      const rateLimited = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
      const fn = vi.fn()
        .mockRejectedValueOnce(rateLimited)
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

describe('classifySendFailure — was it delivered?', () => {
  const withCode = (code: number, msg = 'boom') => Object.assign(new Error(msg), { error_code: code });

  it('calls a 429 rate-limited and carries its retry_after', () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      error_code: 429,
      parameters: { retry_after: 12 },
    });
    expect(classifySendFailure(err)).toEqual({ kind: 'rate_limited', retryAfterMs: 12000 });
  });

  it('defaults a 429 with no retry_after to five seconds', () => {
    expect(classifySendFailure(withCode(429, 'Too Many Requests')).retryAfterMs).toBe(5000);
  });

  it('does not read a stray "429" inside a 4xx message as a rate limit', () => {
    // `Bad Request: can't parse entities … at byte offset 1429` used to match a
    // bare `includes('429')` and burn the retry budget on an error no retry can
    // fix.
    const parseError = Object.assign(
      new Error("Bad Request: can't parse entities in message text: unexpected end of tag at byte offset 1429"),
      { error_code: 400 },
    );
    expect(classifySendFailure(parseError).kind).toBe('rejected');
  });

  it('still recognises a 429 the API only described in words', () => {
    expect(classifySendFailure(new Error('Too Many Requests: retry after 3')).kind).toBe('rate_limited');
  });

  it('caps the 429 backoff so a claimed-but-unsent item is not held for minutes', () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      error_code: 429,
      parameters: { retry_after: 3600 },
    });
    expect(classifySendFailure(err).retryAfterMs).toBe(30_000);
  });

  it('calls a 4xx rejected — Telegram answered and nothing was posted', () => {
    for (const code of [400, 401, 403, 404]) {
      expect(classifySendFailure(withCode(code)).kind, String(code)).toBe('rejected');
    }
  });

  it('calls a 5xx ambiguous — Telegram may have queued it before it broke', () => {
    for (const code of [500, 502, 503]) {
      expect(classifySendFailure(withCode(code)).kind, String(code)).toBe('ambiguous');
    }
  });

  it('calls a lost answer ambiguous, whatever the transport called it', () => {
    const messages = [
      "Network request for 'sendMessage' failed!",
      'fetch failed',
      'The operation was aborted',
      'socket hang up',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo EAI_AGAIN api.telegram.org',
      'ETIMEDOUT',
    ];
    for (const msg of messages) {
      expect(isAmbiguousSendFailure(new Error(msg)), msg).toBe(true);
    }
  });

  it('calls anything thrown before the request left us rejected — nothing was posted', () => {
    // The allowlist guard and the "sendRichMessage not wired" stub both land
    // here; treating them as ambiguous would strand items that never went out.
    expect(classifySendFailure(new UnauthorizedChatError(-1)).kind).toBe('rejected');
    expect(classifySendFailure(new Error('sendRichMessage not wired')).kind).toBe('rejected');
    expect(isAmbiguousSendFailure(new Error('sendRichMessage not wired'))).toBe(false);
  });
});

describe('safeSendMessage — guard only, one attempt', () => {
  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = `${ALLOWED_CHAT},-100456`;
    _setSleepFnForTest(instantSleep);
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    _resetSleepFnForTest();
  });

  it('does not retry a 429, because its callers own the retry', () => {
    // The publisher wraps its injected sender in sendWithRetryFn, so a shim
    // that retried too meant one 429 cost four API attempts and up to 90s of
    // sleep with the event group already claimed but unsent.
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      error_code: 429,
      parameters: { retry_after: 1 },
    });
    const fakeApi = { sendMessage: vi.fn().mockRejectedValue(rateLimited) };

    return expect(safeSendMessage(fakeApi as never, ALLOWED_CHAT, 'hi'))
      .rejects.toThrow('Too Many Requests')
      .then(() => {
        expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1);
      });
  });

  it('still refuses a chat outside the allowlist without calling the API', async () => {
    const fakeApi = { sendMessage: vi.fn() };
    await expect(safeSendMessage(fakeApi as never, -999999, 'hi')).rejects.toThrow(UnauthorizedChatError);
    expect(fakeApi.sendMessage).not.toHaveBeenCalled();
  });
});
