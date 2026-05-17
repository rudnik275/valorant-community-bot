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
});
