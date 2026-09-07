import { describe, it, expect } from 'vitest';
import {
  DAILY_VARIANTS,
  DAILY_VARIANT_LABELS,
  parseDailyVariant,
  renderDailyVariant,
} from './rich-variants.ts';
import type { RichDailyRow } from './rich-render.ts';
import { renderPlayerName, richMatchLink } from '../publisher/player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from '../publisher/valorant-emoji.ts';

const TRACKER = (id: string) => `https://tracker.gg/valorant/match/${id}`;

function row(overrides: Partial<RichDailyRow> = {}): RichDailyRow {
  return {
    eventType: 'ace',
    riotName: 'Ace',
    riotTag: 'ACE',
    agent: 'Jett',
    rank: 'Diamond 3',
    map: 'Ascent',
    matchId: 'm1',
    round0: 2,
    won: true,
    detectedAt: 1_000,
    ...overrides,
  };
}

/**
 * The owner's 2026-09-07 screenshot, as rows. Chronological order matters —
 * it is the order build.ts hands over.
 */
function screenshotDay(): RichDailyRow[] {
  return [
    row({ riotName: 'ШАУРМА С ЕНОТА', riotTag: 'GTZ', map: 'Sunset', matchId: 'm5', eventType: 'knife_kill', round0: 11, detectedAt: 100 }),
    row({ riotName: 'ХоккеисТ', riotTag: 'UA13', map: 'Sunset', matchId: 'm4', eventType: 'knife_kill', round0: 8, rank: 'Gold 1', detectedAt: 200 }),
    row({ riotName: 'ШАУРМА С ЕНОТА', riotTag: 'GTZ', map: 'Ascent', matchId: 'm6', eventType: 'knife_kill', round0: 24, detectedAt: 300 }),
    row({ riotName: 'ШАУРМА С ЕНОТА', riotTag: 'GTZ', map: 'Summit', matchId: 'm1', eventType: 'ace', round0: 19, detectedAt: 400 }),
    row({ riotName: 'kapralv', riotTag: '666', map: 'Summit', matchId: 'm2', eventType: 'ace', round0: 17, rank: 'Platinum 2', detectedAt: 500 }),
    row({ riotName: 'Reflексік4evr', riotTag: 'ilyha', map: 'Haven', matchId: 'm3', eventType: 'ace', round0: 17, rank: 'Ascendant 1', detectedAt: 600 }),
    row({ riotName: 'Reflексік4evr', riotTag: 'ilyha', map: 'Haven', matchId: 'm3', eventType: 'knife_kill', round0: 17, rank: 'Ascendant 1', detectedAt: 600 }),
    row({ riotName: 'Госпожа', riotTag: 'xoxo', map: 'Split', matchId: 'm7', eventType: 'knife_kill', round0: 11, won: false, detectedAt: 700 }),
  ];
}

const TITLE = '<h3>🍿 Эйсы и ножи за сутки</h3>';

describe('renderDailyVariant — every prototype', () => {
  for (const v of DAILY_VARIANTS) {
    describe(`variant ${v} (${DAILY_VARIANT_LABELS[v]})`, () => {
      const html = renderDailyVariant(v, screenshotDay());

      it('opens with the one-line <h3> title, not the wrapping <h2>', () => {
        expect(html.startsWith(TITLE)).toBe(true);
        expect(html).not.toContain('<h2>');
        expect(html).not.toContain('24 часа');
      });

      it('contains NO raw newline — rich HTML collapses them', () => {
        expect(html).not.toContain('\n');
      });

      it('drops the #tag from every nick', () => {
        for (const tag of ['#GTZ', '#UA13', '#666', '#ilyha', '#xoxo']) {
          expect(html).not.toContain(tag);
        }
        expect(html).toContain('<b>ШАУРМА С ЕНОТА</b>');
      });

      it('drops the round numbers and the 🏆/💀 outcome', () => {
        expect(html).not.toMatch(/\(\d+/);
        expect(html).not.toContain('🏆');
        expect(html).not.toContain('💀');
        expect(html).not.toContain('раунд');
      });

      it('uses neither tables nor accordions', () => {
        expect(html).not.toContain('<table');
        expect(html).not.toContain('<details');
      });

      it('never puts a <tg-emoji> inside an <a> (kills the link in rich)', () => {
        expect(html).not.toMatch(/<a href="[^"]*"><tg-emoji/);
      });

      it('HTML-escapes the nick', () => {
        const out = renderDailyVariant(v, [row({ riotName: '<b>x</b>', map: 'A<b>' })]);
        expect(out).not.toContain('<b>x</b>');
        expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(out).not.toContain('A<b>');
      });
    });
  }
});

describe('variant A — «Чисто»', () => {
  it('keeps the by-type skeleton: bold section labels, Эйсы before Ножи', () => {
    const html = renderDailyVariant('A', screenshotDay());
    expect(html).toContain('<b>🎯 Эйсы</b>');
    expect(html).toContain('<b>🔪 Ножи</b>');
    expect(html.indexOf('🎯 Эйсы')).toBeLessThan(html.indexOf('🔪 Ножи'));
    expect(html).not.toContain('<h3>🎯');
  });

  it('separates the two sections with a blank line', () => {
    const html = renderDailyVariant('A', screenshotDay());
    expect(html).toContain('<br><br><b>🔪 Ножи</b>');
  });

  it('renders one line per player+match as `ник · 🗺 Карта` — agent icon kept', () => {
    const html = renderDailyVariant('A', [row()]);
    const nick = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: 'Diamond 3',
      agent: 'Jett',
      hideTag: true,
    });
    const link = richMatchLink({ url: TRACKER('m1'), mapName: 'Ascent' });
    expect(html).toContain(`${nick} · ${link}`);
    expect(html).toContain(agentToEmojiHtml('Jett'));
  });

  it('keeps the bold ×N for several of one kind in ONE match, never ×1', () => {
    const html = renderDailyVariant('A', [
      row({ round0: 1 }),
      row({ round0: 5 }),
      row({ round0: 9 }),
      row({ matchId: 'm2', map: 'Bind', round0: 3 }),
    ]);
    expect(html.match(/×\d+/g)).toEqual(['×3']);
    expect(html).toContain('<b>×3</b> ·');
    expect(html.indexOf('×3')).toBeLessThan(html.indexOf('Bind'));
  });

  it('omits an empty section entirely', () => {
    const html = renderDailyVariant('A', [row({ eventType: 'knife_kill' })]);
    expect(html).not.toContain('Эйсы</b>');
    expect(html).toContain('<b>🔪 Ножи</b>');
  });

  it('keeps chronological order inside a section', () => {
    const html = renderDailyVariant('A', screenshotDay());
    const knives = html.slice(html.indexOf('🔪 Ножи'));
    expect(knives.indexOf('ХоккеисТ')).toBeLessThan(knives.indexOf('Reflексік4evr'));
    expect(knives.indexOf('Reflексік4evr')).toBeLessThan(knives.indexOf('Госпожа'));
  });
});

describe('variant B — «По игрокам»', () => {
  it('is a block per player: nick line, <br>, then the matches', () => {
    const html = renderDailyVariant('B', [row()]);
    const header = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: 'Diamond 3',
      hideTag: true,
    });
    expect(html).toBe(`${TITLE}${header}<br>🎯 <a href="${TRACKER('m1')}">Ascent</a>`);
  });

  it('has no type sections and no agent icons', () => {
    const html = renderDailyVariant('B', screenshotDay());
    expect(html).not.toContain('Эйсы</b>');
    expect(html).not.toContain('Ножи</b>');
    expect(html).not.toContain(agentToEmojiHtml('Jett'));
  });

  it('links the bare map name — the tally is the icon, no map emoji on top', () => {
    const html = renderDailyVariant('B', [row({ map: 'Ascent' })]);
    const mapIcon = mapToEmojiHtml('Ascent');
    expect(mapIcon).not.toBe(''); // the assertion below is only meaningful with a real icon
    expect(html).not.toContain(mapIcon);
    expect(html).toContain(`🎯 <a href="${TRACKER('m1')}">Ascent</a>`);
  });

  it('merges ace + knife of the same match into one `🎯🔪 Map` item, aces first', () => {
    const html = renderDailyVariant('B', screenshotDay());
    expect(html).toContain(`🎯🔪 <a href="${TRACKER('m3')}">Haven</a>`);
    expect(html.match(/Haven/g)?.length).toBe(1);
  });

  it('repeats the emoji per event in one match and joins matches with «·»', () => {
    const html = renderDailyVariant('B', [
      row({ eventType: 'knife_kill', matchId: 'k1', map: 'Bind', round0: 1 }),
      row({ eventType: 'knife_kill', matchId: 'k1', map: 'Bind', round0: 7 }),
      row({ matchId: 'm2', map: 'Lotus' }),
    ]);
    expect(html).toContain(`🔪🔪 <a href="${TRACKER('k1')}">Bind</a> · 🎯 <a href="${TRACKER('m2')}">Lotus</a>`);
  });

  it('sorts players by total events desc, ties by first appearance; blank line between', () => {
    const html = renderDailyVariant('B', screenshotDay());
    const order = ['ШАУРМА С ЕНОТА', 'Reflексік4evr', 'ХоккеисТ', 'kapralv', 'Госпожа'].map((n) =>
      html.indexOf(`<b>${n}</b>`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/<br><br>/g)?.length).toBe(4);
  });
});

describe('variant C — «Табло»', () => {
  it('is one line per player: nick — tally, each glyph linking to its match', () => {
    const html = renderDailyVariant('C', [row()]);
    const header = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: 'Diamond 3',
      hideTag: true,
    });
    expect(html).toBe(`${TITLE}${header} — <a href="${TRACKER('m1')}">🎯</a>`);
  });

  it('shows no map names, no agents, no sections, no blank lines', () => {
    const html = renderDailyVariant('C', screenshotDay());
    for (const map of ['Summit', 'Haven', 'Sunset', 'Ascent', 'Split']) expect(html).not.toContain(map);
    expect(html).not.toContain(agentToEmojiHtml('Jett'));
    expect(html).not.toContain('Эйсы</b>');
    expect(html).not.toContain('<br><br>');
  });

  it('puts aces before knives and groups each match into one link', () => {
    const html = renderDailyVariant('C', screenshotDay());
    expect(html).toContain(
      `<b>Reflексік4evr</b> — <a href="${TRACKER('m3')}">🎯</a><a href="${TRACKER('m3')}">🔪</a>`,
    );
    expect(html).toContain(
      `<b>ШАУРМА С ЕНОТА</b> — <a href="${TRACKER('m1')}">🎯</a><a href="${TRACKER('m5')}">🔪</a><a href="${TRACKER('m6')}">🔪</a>`,
    );
  });

  it('collapses a wall of one kind into ×N past five', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((r) => row({ eventType: 'knife_kill', round0: r }));
    expect(renderDailyVariant('C', rows)).toContain(`<a href="${TRACKER('m1')}">🔪×6</a>`);
    expect(renderDailyVariant('C', rows.slice(0, 5))).toContain('🔪🔪🔪🔪🔪</a>');
  });

  it('sorts players by total events desc', () => {
    const html = renderDailyVariant('C', screenshotDay());
    expect(html.indexOf('ШАУРМА С ЕНОТА')).toBeLessThan(html.indexOf('Reflексік4evr'));
    expect(html.indexOf('Reflексік4evr')).toBeLessThan(html.indexOf('ХоккеисТ'));
  });
});

describe('parseDailyVariant', () => {
  it('accepts a/b/c in either case', () => {
    expect(parseDailyVariant('a')).toBe('A');
    expect(parseDailyVariant('B')).toBe('B');
    expect(parseDailyVariant(' c ')).toBe('C');
  });

  it('rejects anything else', () => {
    expect(parseDailyVariant('d')).toBeNull();
    expect(parseDailyVariant('3')).toBeNull();
    expect(parseDailyVariant('')).toBeNull();
    expect(parseDailyVariant(undefined)).toBeNull();
  });
});
