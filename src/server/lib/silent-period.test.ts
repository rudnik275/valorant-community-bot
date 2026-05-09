import { describe, it, expect, vi, afterEach } from 'vitest';

const mockLogger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('./log.ts', () => ({ default: mockLogger }));

// Import after mock is set up
const { isPublishingEnabled } = await import('./silent-period.ts');

describe('isPublishingEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns true when env is unset', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', '');
    expect(isPublishingEnabled()).toBe(true);
  });

  it('returns true when env is empty string', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', '');
    expect(isPublishingEnabled(new Date())).toBe(true);
  });

  it('returns true when env is whitespace only', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', '   ');
    expect(isPublishingEnabled(new Date())).toBe(true);
  });

  it('returns true when env timestamp is in the past', () => {
    const past = new Date(Date.now() - 86400000).toISOString(); // yesterday
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', past);
    expect(isPublishingEnabled(new Date())).toBe(true);
  });

  it('returns false when env timestamp is in the future', () => {
    const future = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);
    expect(isPublishingEnabled(new Date())).toBe(false);
  });

  it('returns false and logs error when env is "foo" (invalid)', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', 'foo');
    expect(isPublishingEnabled(new Date())).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'silent-period', value: 'foo' }),
      expect.any(String),
    );
  });

  it('returns false and logs error when env is "2026-13-99" (invalid date)', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', '2026-13-99');
    expect(isPublishingEnabled(new Date())).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledOnce();
  });

  it('returns false and logs error when env is "not-a-date"', () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', 'not-a-date');
    expect(isPublishingEnabled(new Date())).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledOnce();
  });

  it('returns true when now equals the threshold exactly (>= boundary)', () => {
    const exact = new Date(1_746_000_000_000);
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', exact.toISOString());
    // Pass the exact same moment — should be >= so returns true
    expect(isPublishingEnabled(exact)).toBe(true);
  });

  it('returns false when now is 1ms before the threshold', () => {
    const threshold = new Date(1_746_000_000_000);
    const justBefore = new Date(threshold.getTime() - 1);
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', threshold.toISOString());
    expect(isPublishingEnabled(justBefore)).toBe(false);
  });
});
