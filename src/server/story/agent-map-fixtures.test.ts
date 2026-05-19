import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { normalizeSlug, resolveAgentImage, resolveMapImage } from './agent-map-fixtures.ts';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;

describe('normalizeSlug', () => {
  // Henrik display name → expected on-disk slug. Issue #227 §11 checklist.
  const cases: Array<[string, string]> = [
    ['Jett', 'jett'],
    ['KAY/O', 'kayo'],
    ['Killjoy', 'killjoy'],
    ['Ascent', 'ascent'],
    ['Breeze', 'breeze'],
    ['Lotus', 'lotus'],
    ['Brimstone', 'brimstone'],
    ['Cypher', 'cypher'],
    ['  Sage  ', 'sage'],
    ['Phoenix', 'phoenix'],
    ['KAY / O', 'kayo'],
    ['Icebox', 'icebox'],
  ];

  it.each(cases)('normalizes %s → %s', (input, expected) => {
    expect(normalizeSlug(input)).toBe(expected);
  });

  it('strips accents to ascii', () => {
    expect(normalizeSlug('Clové')).toBe('clove');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(normalizeSlug('---')).toBe('');
  });
});

describe('resolveAgentImage', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the path when the PNG exists', () => {
    existsSyncMock.mockReturnValue(true);
    const path = resolveAgentImage('Jett');
    expect(path).not.toBeNull();
    expect(path).toMatch(/src\/assets\/agents\/jett\.png$/);
    expect(existsSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/src\/assets\/agents\/jett\.png$/),
    );
  });

  it('normalizes KAY/O before resolving', () => {
    existsSyncMock.mockReturnValue(true);
    const path = resolveAgentImage('KAY/O');
    expect(path).toMatch(/agents\/kayo\.png$/);
  });

  it('returns null when the PNG is absent', () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolveAgentImage('Jett')).toBeNull();
  });

  it('returns null for null/empty name without touching fs', () => {
    expect(resolveAgentImage(null)).toBeNull();
    expect(resolveAgentImage(undefined)).toBeNull();
    expect(resolveAgentImage('')).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('returns null when the name normalizes to empty', () => {
    expect(resolveAgentImage('///')).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});

describe('resolveMapImage', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the path when the PNG exists', () => {
    existsSyncMock.mockReturnValue(true);
    const path = resolveMapImage('Ascent');
    expect(path).toMatch(/src\/assets\/maps\/ascent\.png$/);
  });

  it('returns null when the PNG is absent', () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolveMapImage('Ascent')).toBeNull();
  });

  it('returns null for null name without touching fs', () => {
    expect(resolveMapImage(null)).toBeNull();
    expect(existsSyncMock).not.toHaveBeenCalled();
  });
});
