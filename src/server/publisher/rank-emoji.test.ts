import { describe, it, expect } from 'vitest';
import { rankToEmojiHtml, RANK_LABEL_TO_ID, RANK_EMOJI } from './rank-emoji.ts';

describe('rankToEmojiHtml', () => {
  it('returns correct tag for Diamond 3', () => {
    expect(rankToEmojiHtml('Diamond 3')).toBe(
      '<tg-emoji emoji-id="5190612593059864801">💎</tg-emoji>',
    );
  });

  it('returns correct tag for Unranked', () => {
    expect(rankToEmojiHtml('Unranked')).toBe(
      '<tg-emoji emoji-id="5188639300400487669">❓</tg-emoji>',
    );
  });

  it('returns correct tag for Radiant', () => {
    expect(rankToEmojiHtml('Radiant')).toBe(
      '<tg-emoji emoji-id="5190818141604715555">🌟</tg-emoji>',
    );
  });

  it('returns "" for null', () => {
    expect(rankToEmojiHtml(null)).toBe('');
  });

  it('returns "" for undefined', () => {
    expect(rankToEmojiHtml(undefined)).toBe('');
  });

  it('returns "" for unrecognised rank label', () => {
    expect(rankToEmojiHtml('Bogus')).toBe('');
  });

  it('returns "" for empty string', () => {
    expect(rankToEmojiHtml('')).toBe('');
  });
});

describe('RANK_LABEL_TO_ID and RANK_EMOJI integrity', () => {
  it('RANK_LABEL_TO_ID has exactly 26 entries', () => {
    expect(Object.keys(RANK_LABEL_TO_ID).length).toBe(26);
  });

  it('every RANK_LABEL_TO_ID value is a key in RANK_EMOJI', () => {
    for (const [label, id] of Object.entries(RANK_LABEL_TO_ID)) {
      expect(RANK_EMOJI[id], `missing RANK_EMOJI entry for label "${label}" (id ${id})`).toBeDefined();
    }
  });

  it('RANK_EMOJI has exactly 26 entries with canonical IDs', () => {
    expect(Object.keys(RANK_EMOJI).length).toBe(26);
  });
});
