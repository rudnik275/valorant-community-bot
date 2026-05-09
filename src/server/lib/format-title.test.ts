import { describe, it, expect } from 'vitest';
import { formatRiotTitle } from './format-title.ts';

describe('formatRiotTitle', () => {
  it('returns name#tag as-is when total length <= 16', () => {
    // 'rudi' + '#' + '1001' = 9 chars
    expect(formatRiotTitle('rudi', '1001')).toBe('rudi#1001');
  });

  it('returns full string when exactly 16 chars', () => {
    // 'TwelveLetter' (12) + '#' + 'TAG' (3) = 16
    expect(formatRiotTitle('TwelveLetter', 'TAG')).toBe('TwelveLetter#TAG');
  });

  it('truncates name to fit within 16 chars, preserving full #TAG', () => {
    // 'VeryLongPlayerName' (18) + '#' + 'TAG1' (4) = 23 chars
    // 16 - 5 (#TAG1) = 11 chars for name → 'VeryLongPla'
    const result = formatRiotTitle('VeryLongPlayerName', 'TAG1');
    expect(result).toBe('VeryLongPla#TAG1');
    expect(result.length).toBe(16);
  });

  it('truncates name correctly when tag is 5 chars', () => {
    // name = 'LongName' (8), tag = 'NA123' (5) → full = 'LongName#NA123' = 14 → fits
    expect(formatRiotTitle('LongName', 'NA123')).toBe('LongName#NA123');
  });

  it('truncates name when tag is long and name would exceed limit', () => {
    // name = 'LongLongName' (12), tag = 'NA123' (5) → full = 'LongLongName#NA123' = 18
    // 16 - 6 (#NA123) = 10 → 'LongLongNa'
    const result = formatRiotTitle('LongLongName', 'NA123');
    expect(result).toBe('LongLongNa#NA123');
    expect(result.length).toBe(16);
  });
});
