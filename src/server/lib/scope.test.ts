import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadAllowedChatIds, isAllowedChat, _resetCache } from './scope.ts';

describe('loadAllowedChatIds', () => {
  const originalEnv = process.env['TELEGRAM_ALLOWED_CHAT_IDS'];

  beforeEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
  });

  afterEach(() => {
    _resetCache();
    if (originalEnv !== undefined) {
      process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = originalEnv;
    } else {
      delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
    }
  });

  it('throws when env var is not set', () => {
    expect(() => loadAllowedChatIds()).toThrow(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set or empty',
    );
  });

  it('throws when env var is empty string', () => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '';
    expect(() => loadAllowedChatIds()).toThrow(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set or empty',
    );
  });

  it('throws on invalid format (letters)', () => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = 'abc,def';
    expect(() => loadAllowedChatIds()).toThrow();
  });

  it('throws on invalid format (trailing comma)', () => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '-100123,';
    expect(() => loadAllowedChatIds()).toThrow();
  });

  it('parses two negative chat IDs into a Set of two', () => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '-100123,-100456';
    const result = loadAllowedChatIds();
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    expect(result.has(-100123)).toBe(true);
    expect(result.has(-100456)).toBe(true);
  });

  it('parses a single positive chat ID', () => {
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '12345';
    const result = loadAllowedChatIds();
    expect(result.size).toBe(1);
    expect(result.has(12345)).toBe(true);
  });
});

describe('isAllowedChat', () => {
  beforeEach(() => {
    _resetCache();
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '-100123,-100456';
  });

  afterEach(() => {
    _resetCache();
    delete process.env['TELEGRAM_ALLOWED_CHAT_IDS'];
  });

  it('returns true for allowed chat ID', () => {
    expect(isAllowedChat(-100123)).toBe(true);
  });

  it('returns false for disallowed chat ID', () => {
    expect(isAllowedChat(-999999)).toBe(false);
  });
});
