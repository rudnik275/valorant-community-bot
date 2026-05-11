import { describe, it, expect } from 'vitest';
import { renderList } from './render-list.ts';

describe('renderList()', () => {
  it('returns empty string for 0 items', () => {
    expect(renderList([])).toBe('');
  });

  it('returns the item as-is for 1 item (no bullet)', () => {
    expect(renderList(['Ник — 12 побед подряд'])).toBe('Ник — 12 побед подряд');
  });

  it('returns bulleted list separated by newlines for 2 items', () => {
    const result = renderList(['Ник — 12 побед подряд', 'Ник2 — 10']);
    expect(result).toBe('• Ник — 12 побед подряд\n• Ник2 — 10');
  });

  it('returns bulleted list for 3 items', () => {
    const result = renderList(['Alpha', 'Beta', 'Gamma']);
    expect(result).toBe('• Alpha\n• Beta\n• Gamma');
  });

  it('single item contains no bullet prefix', () => {
    const result = renderList(['only item']);
    expect(result).not.toContain('•');
  });

  it('multi-item: every line starts with a bullet', () => {
    const result = renderList(['one', 'two', 'three']);
    const lines = result.split('\n');
    for (const line of lines) {
      expect(line.startsWith('• ')).toBe(true);
    }
  });
});
