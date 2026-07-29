import { describe, it, expect } from 'vitest';
import { OnboardBodySchema } from '../../shared/schemas/onboard.ts';

/**
 * Parity test: verifies that the shared OnboardBodySchema accepts/rejects the
 * same boundary inputs that both server and client were independently enforcing.
 * This prevents the server ↔ client drift that motivated #257.
 */
describe('OnboardBodySchema (shared) — boundary parity', () => {
  const valid = (name: string, tag: string) =>
    OnboardBodySchema.safeParse({ name, tag }).success;

  const parsed = (name: string, tag: string) => {
    const r = OnboardBodySchema.safeParse({ name, tag });
    if (!r.success) throw new Error(`expected valid input, got ${r.error.message}`);
    return r.data;
  };

  // ── Accept ───────────────────────────────────────────────────────────────────

  it('accepts a minimal valid input', () => {
    expect(valid('A', '1')).toBe(true);
  });

  it('accepts name with exactly 16 chars', () => {
    expect(valid('A'.repeat(16), 'EU1')).toBe(true);
  });

  it('accepts tag with exactly 5 chars', () => {
    expect(valid('Player', 'EU123')).toBe(true);
  });

  it('accepts alphanumeric tag with mixed case', () => {
    expect(valid('Player', 'aB1cD')).toBe(true);
  });

  // ── Reject ───────────────────────────────────────────────────────────────────

  it('rejects empty name', () => {
    expect(valid('', 'EU1')).toBe(false);
  });

  it('rejects empty tag', () => {
    expect(valid('Player', '')).toBe(false);
  });

  it('rejects name with 17 chars', () => {
    expect(valid('A'.repeat(17), 'EU1')).toBe(false);
  });

  it('rejects tag with 6 chars', () => {
    expect(valid('Player', 'EU1234')).toBe(false);
  });

  it('rejects tag with a space ("a b")', () => {
    expect(valid('Player', 'a b')).toBe(false);
  });

  it('rejects tag with special char ("abc!")', () => {
    expect(valid('Player', 'abc!')).toBe(false);
  });

  it('rejects tag with hash (#)', () => {
    expect(valid('Player', 'EU#1')).toBe(false);
  });

  // ── Unicode Riot IDs ─────────────────────────────────────────────────────────
  // A member with a Cyrillic tagline was hard-blocked from onboarding (and so
  // stayed read-only in the group) by an ASCII-only `[a-zA-Z0-9]` tag regex.

  it('accepts the Cyrillic Riot ID that regressed onboarding', () => {
    expect(valid('Любовница Омена', 'тётя')).toBe(true);
  });

  it('accepts a CJK tag', () => {
    expect(valid('Player', '日本')).toBe(true);
  });

  it('accepts an accented-Latin tag', () => {
    expect(valid('Player', 'Ñoño')).toBe(true);
  });

  it('still rejects a non-ASCII tag made of punctuation', () => {
    expect(valid('Player', '«»')).toBe(false);
  });

  // ── Normalization ────────────────────────────────────────────────────────────

  it('normalizes decomposed input to NFC (mobile keyboards emit NFD)', () => {
    const nfd = 'тётя'.normalize('NFD');
    expect(nfd).not.toBe('тётя');
    expect(parsed('Player', nfd).tag).toBe('тётя');
  });

  it('measures length after NFC, not on raw code units', () => {
    // 5 chars decomposed = 10 UTF-16 units; must not trip the max-5 limit.
    expect(valid('Player', 'ёёёёё'.normalize('NFD'))).toBe(true);
    expect(valid('Player', 'ёёёёёё')).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(parsed('  Player  ', ' EU1 ')).toEqual({ name: 'Player', tag: 'EU1' });
  });

  it('converts a pasted non-breaking space into a regular space', () => {
    expect(parsed('Любовница\u00A0Омена', 'EU1').name).toBe('Любовница Омена');
  });

  it('strips zero-width characters dragged in by copy-paste', () => {
    expect(parsed('Player\u200B', '\uFEFFEU1').tag).toBe('EU1');
  });

  it('rejects input that is only whitespace', () => {
    expect(valid('   ', 'EU1')).toBe(false);
    expect(valid('Player', ' ')).toBe(false);
    expect(valid('Player', '\u00A0')).toBe(false);
  });
});
