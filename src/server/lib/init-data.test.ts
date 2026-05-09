import { describe, it, expect } from 'vitest';
import { sign } from '@telegram-apps/init-data-node';
import { verifyInitData, InvalidInitDataError } from './init-data.ts';

const BOT_TOKEN = 'test-bot-token-12345';

// Build a valid initData string using the library's own `sign` helper
function makeValidInitData(overrideAuthDate?: Date): string {
  const authDate = overrideAuthDate ?? new Date();
  return sign(
    { user: { id: 42, first_name: 'Alice', username: 'alice_tg' } },
    BOT_TOKEN,
    authDate,
  );
}

describe('verifyInitData', () => {
  it('returns the user when initData is valid and fresh', () => {
    const raw = makeValidInitData();
    const user = verifyInitData(raw, BOT_TOKEN);
    expect(user.id).toBe(42);
    expect(user.username).toBe('alice_tg');
    expect(user.first_name).toBe('Alice');
  });

  it('throws InvalidInitDataError when HMAC is invalid', () => {
    const raw = makeValidInitData();
    // Tamper with the hash by signing with a different token
    const badRaw = raw.replace(/hash=[^&]+/, 'hash=deadbeef');
    expect(() => verifyInitData(badRaw, BOT_TOKEN)).toThrow(InvalidInitDataError);
  });

  it('throws InvalidInitDataError when auth_date is expired (>24h)', () => {
    // auth_date set 25 hours in the past
    const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const raw = makeValidInitData(pastDate);
    expect(() => verifyInitData(raw, BOT_TOKEN)).toThrow(InvalidInitDataError);
  });

  it('throws InvalidInitDataError when initData is completely wrong', () => {
    expect(() => verifyInitData('totally-invalid-data', BOT_TOKEN)).toThrow(InvalidInitDataError);
  });

  it('throws InvalidInitDataError when signed with a different token', () => {
    const raw = makeValidInitData();
    expect(() => verifyInitData(raw, 'different-token')).toThrow(InvalidInitDataError);
  });
});
