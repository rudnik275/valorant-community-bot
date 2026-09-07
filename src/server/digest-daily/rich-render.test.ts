import { describe, it, expect } from 'vitest';
import {
  buildDailyModel,
  renderRichDailyDigest,
  type DailyDigestModel,
  type DailyOccurrence,
} from './rich-render.ts';
import { renderPlayerName } from '../publisher/player-render.ts';

const TITLE = '<h2>🍿 Daily Ace/Knife</h2>';

function occ(overrides: Partial<DailyOccurrence> = {}): DailyOccurrence {
  return { eventType: 'ace', name: 'Ace', tag: 'ACE', count: 1, ...overrides };
}

describe('buildDailyModel', () => {
  it('folds one occurrence into one standing', () => {
    expect(buildDailyModel([occ()])).toEqual({
      aces: [{ name: 'Ace', tag: 'ACE', count: 1 }],
      knives: [],
    });
  });

  it('sums a player across several events (matches) of the same type', () => {
    const model = buildDailyModel([occ({ count: 2 }), occ({ count: 1 })]);
    expect(model.aces).toEqual([{ name: 'Ace', tag: 'ACE', count: 3 }]);
  });

  it('keeps aces and knives of the same player apart', () => {
    const model = buildDailyModel([occ(), occ({ eventType: 'knife_kill', count: 2 })]);
    expect(model.aces).toEqual([{ name: 'Ace', tag: 'ACE', count: 1 }]);
    expect(model.knives).toEqual([{ name: 'Ace', tag: 'ACE', count: 2 }]);
  });

  it('sorts by count descending, ties in first-appearance order', () => {
    const model = buildDailyModel([
      occ({ name: 'First', count: 1 }),
      occ({ name: 'Big', count: 3 }),
      occ({ name: 'Second', count: 1 }),
    ]);
    expect(model.aces.map((s) => s.name)).toEqual(['Big', 'First', 'Second']);
  });

  it('treats a different tag as a different player', () => {
    const model = buildDailyModel([occ({ tag: 'A' }), occ({ tag: 'B' })]);
    expect(model.aces).toHaveLength(2);
  });

  it('drops zero-count occurrences', () => {
    expect(buildDailyModel([occ({ count: 0 })])).toEqual({ aces: [], knives: [] });
  });
});

describe('renderRichDailyDigest', () => {
  const nick = (name: string, tag: string) => renderPlayerName({ name, tag, isCommunity: true });

  it('renders the title as an <h2>, a section as <h3> + bullet list', () => {
    const html = renderRichDailyDigest({ aces: [{ name: 'Ace', tag: 'ACE', count: 1 }], knives: [] });
    expect(html).toBe(`${TITLE}<h3>🎯 Aces</h3><ul><li>${nick('Ace', 'ACE')}</li></ul>`);
  });

  it('bold Name#Tag via the global helper — no rank icon, no agent icon', () => {
    const html = renderRichDailyDigest({ aces: [{ name: 'Ace', tag: 'ACE', count: 1 }], knives: [] });
    expect(html).toContain('<li><b>Ace#ACE</b></li>');
    expect(html).not.toContain('<tg-emoji');
  });

  it('appends ×N for more than one, never ×1', () => {
    const html = renderRichDailyDigest({
      aces: [
        { name: 'Three', tag: 'T', count: 3 },
        { name: 'One', tag: 'O', count: 1 },
      ],
      knives: [],
    });
    expect(html).toContain('<li><b>Three#T</b> ×3</li>');
    expect(html).toContain('<li><b>One#O</b></li>');
    expect(html.match(/×/g)?.length).toBe(1);
  });

  it('renders the knife section after the ace section', () => {
    const html = renderRichDailyDigest({
      aces: [{ name: 'A', tag: 'A', count: 1 }],
      knives: [{ name: 'K', tag: 'K', count: 2 }],
    });
    expect(html).toBe(
      `${TITLE}<h3>🎯 Aces</h3><ul><li>${nick('A', 'A')}</li></ul>` +
        `<h3>🔪 Knives</h3><ul><li>${nick('K', 'K')} ×2</li></ul>`,
    );
  });

  it('omits an empty section entirely', () => {
    const knivesOnly: DailyDigestModel = { aces: [], knives: [{ name: 'K', tag: 'K', count: 1 }] };
    const html = renderRichDailyDigest(knivesOnly);
    expect(html).not.toContain('Aces');
    expect(html).toContain('<h3>🔪 Knives</h3>');
  });

  it('carries no map, no link, no round numbers, no legend, no table', () => {
    const html = renderRichDailyDigest({
      aces: [{ name: 'A', tag: 'A', count: 2 }],
      knives: [{ name: 'A', tag: 'A', count: 1 }],
    });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('tracker.gg');
    expect(html).not.toContain('🏆');
    expect(html).not.toContain('💀');
    expect(html).not.toContain('раунд');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<blockquote');
  });

  it('contains NO raw newline — rich HTML collapses them', () => {
    const html = renderRichDailyDigest({
      aces: [{ name: 'A', tag: 'A', count: 1 }, { name: 'B', tag: 'B', count: 1 }],
      knives: [{ name: 'A', tag: 'A', count: 1 }],
    });
    expect(html).not.toContain('\n');
  });

  it('HTML-escapes the nick', () => {
    const html = renderRichDailyDigest({ aces: [{ name: '<b>x</b>', tag: '<i>', count: 1 }], knives: [] });
    expect(html).toContain('<li><b>&lt;b&gt;x&lt;/b&gt;#&lt;i&gt;</b></li>');
    expect(html).not.toContain('<b>x</b>');
  });

  it('renders the model in the order it was given (sorting is buildDailyModel\'s job)', () => {
    const html = renderRichDailyDigest({
      aces: [
        { name: 'Z', tag: 'Z', count: 1 },
        { name: 'A', tag: 'A', count: 1 },
      ],
      knives: [],
    });
    expect(html.indexOf('Z#Z')).toBeLessThan(html.indexOf('A#A'));
  });
});
