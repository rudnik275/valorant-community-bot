import { describe, it, expect } from 'vitest';
import { renderRichDigest, mapSplashUrl, type RichDigestModel } from './rich-render.ts';

/** A fully-populated model exercising every section. */
function fullModel(overrides: Partial<RichDigestModel> = {}): RichDigestModel {
  return {
    headerDate: '27 апреля 2025 г.',
    coverMap: 'Ascent',
    totalMatches: 42,
    records: [
      {
        emoji: '💀',
        title: 'Серийный маньяк',
        player: { name: 'Killer', tag: 'KLL', rank: 'Diamond 3', agent: 'Jett' },
        value: '38 фрагов',
        matchUrl: 'https://tracker.gg/valorant/match/m-kills',
        mapName: 'Ascent',
        context: 'рекорд по количеству фрагов за игру',
      },
      {
        emoji: '👑',
        title: 'Король MVP за неделю',
        player: { name: 'Chief', tag: 'MVP', rank: null, agent: null },
        value: '5 MVP-матчей',
        matchUrl: null,
        mapName: null,
        context: 'рекорд по количеству MVP-матчей за неделю',
      },
    ],
    winstreaks: [{ name: 'Alpha', tag: 'AAA', streak: 12 }],
    promotions: [{ name: 'Climber', tag: 'UP', rank: 'Platinum 1' }],
    weaponMasters: [
      {
        weaponEmojiHtml: '<tg-emoji emoji-id="5267384313137108259">🔫</tg-emoji>',
        weapon: 'Vandal',
        value: 24,
        playerHtml: '<b>Alpha#AAA</b>',
      },
      {
        weaponEmojiHtml: '<tg-emoji emoji-id="5267421855446243759">🔫</tg-emoji>',
        weapon: 'Phantom',
        value: 18,
        playerHtml: '<b>Beta#BBB</b>',
      },
    ],
    nearMisses: [
      {
        emoji: '💀',
        header: 'Был(ла) близко к рекорду по киллам',
        player: { name: 'NearMisser', tag: 'NM', agent: 'Sova' },
        value: '29 фрагов',
      },
    ],
    mostActive: { nameHtml: '<b>Alpha#AAA</b>', count: 7 },
    topMaps: [
      { emojiHtml: '<tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji>', map: 'Ascent', count: 12 },
      { emojiHtml: '', map: 'UnknownMap', count: 3 },
    ],
    topAgents: [
      { emojiHtml: '<tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji>', agent: 'Jett', count: 15 },
    ],
    ...overrides,
  };
}

describe('mapSplashUrl', () => {
  it('resolves a known map to its media.valorant-api.com splash URL', () => {
    expect(mapSplashUrl('Ascent')).toBe(
      'https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png',
    );
  });
  it('resolves Summit (#311)', () => {
    expect(mapSplashUrl('Summit')).toBe(
      'https://media.valorant-api.com/maps/756da597-416b-c0f2-f47b-afbdf28670bc/splash.png',
    );
  });
  it('normalises case/punctuation', () => {
    expect(mapSplashUrl('ascent')).toBe(mapSplashUrl('Ascent'));
  });
  it('returns null for unknown map or nullish', () => {
    expect(mapSplashUrl('NotAMap')).toBeNull();
    expect(mapSplashUrl(null)).toBeNull();
    expect(mapSplashUrl(undefined)).toBeNull();
  });
});

describe('renderRichDigest', () => {
  it('renders the title as an <h2> with the date', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h2>📅 Дайджест за неделю · 27 апреля 2025 г.</h2>');
  });

  it('renders the cover image for the top map right after the title', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain(
      '<img src="https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png">',
    );
    // Cover sits between the h2 and the pulse line.
    expect(html.indexOf('<img')).toBeGreaterThan(html.indexOf('</h2>'));
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('📊 За неделю'));
  });

  it('omits the cover image entirely when the top map is unknown or absent', () => {
    expect(renderRichDigest(fullModel({ coverMap: 'NotAMap' }))).not.toContain('<img');
    expect(renderRichDigest(fullModel({ coverMap: null }))).not.toContain('<img');
  });

  it('renders the pulse line', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('📊 За неделю мы сыграли <b>42</b> матчей');
  });

  it('renders each record as a <details> accordion with summary + blockquote context', () => {
    const html = renderRichDigest(fullModel());
    // Summary: emoji <b>title</b><br>renderPlayerName · value · matchLink
    expect(html).toContain(
      '<details><summary>💀 <b>Серийный маньяк</b><br>' +
        '<tg-emoji emoji-id="5265219666799795636">💎</tg-emoji> <b>Killer#KLL</b> <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji>' +
        ' · 38 фрагов · ' +
        '<a href="https://tracker.gg/valorant/match/m-kills"><tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> Ascent</a>' +
        '</summary><blockquote><i>рекорд по количеству фрагов за игру</i></blockquote></details>',
    );
  });

  it('renders an aggregate record (Король MVP) with no match link, no agent, no rank', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain(
      '<details><summary>👑 <b>Король MVP за неделю</b><br><b>Chief#MVP</b> · 5 MVP-матчей' +
        '</summary><blockquote><i>рекорд по количеству MVP-матчей за неделю</i></blockquote></details>',
    );
    // The aggregate record has no <a> link in its summary.
    const mvpBlock = html.slice(html.indexOf('👑'), html.indexOf('</details>', html.indexOf('👑')));
    expect(mvpBlock).not.toContain('<a href');
  });

  it('renders the winstreak card without <details> and without a match link', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('🏆 <b>Винстрик недели:</b><br><b>Alpha#AAA</b> · 12 побед подряд');
    // The winstreak card is not wrapped in details.
    const idx = html.indexOf('Винстрик недели');
    const before = html.slice(0, idx);
    // no <details><summary> immediately wrapping the winstreak text
    expect(html).not.toContain('<summary>🏆 <b>Винстрик');
  });

  it('renders promotions as an <h3> + table Игрок | Ранг with rank emoji', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h3>🎖 Повышение по службе</h3>');
    expect(html).toContain('<table><tr><th>Игрок</th><th>Ранг</th></tr>');
    // Platinum 1 → 🐳 rank emoji id from rank-emoji.ts.
    expect(html).toContain(
      '<tr><td><b>Climber#UP</b></td><td><tg-emoji emoji-id="5264763678711913942">🐳</tg-emoji></td></tr>',
    );
  });

  it('renders «Мастера своего дела» as a striped table with align=right frags', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h3>🔫 Мастера своего дела</h3>');
    expect(html).toContain('<i>лидеры по убийствам одним оружием за матч</i>');
    expect(html).toContain('<table striped><tr><th>Оружие</th><th>Фраги</th><th>Игрок</th></tr>');
    expect(html).toContain(
      '<td><tg-emoji emoji-id="5267384313137108259">🔫</tg-emoji> Vandal</td><td align="right">24</td><td><b>Alpha#AAA</b></td>',
    );
  });

  it('renders near-miss as OPEN blocks (not details) with renderPlayerName and value', () => {
    const html = renderRichDigest(fullModel());
    expect(html).not.toContain('<details><summary>💨');
    // emoji <u>header</u><br>renderPlayerName · value; agent from the match rides along.
    expect(html).toContain(
      '💀 <u>Был(ла) близко к рекорду по киллам</u><br><b>NearMisser#NM</b> <tg-emoji emoji-id="5267031954020145619">🦸</tg-emoji> · 29 фрагов',
    );
  });

  it('renders the most-active line as a plain bold nick (aggregate, no icons)', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('🏆 <b>Больше всех матчей</b><br><b>Alpha#AAA</b> · 7 за неделю');
  });

  it('renders top-maps and top-agents tables with align=right counts', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h3>🗺 Чаще всего играли на</h3>');
    expect(html).toContain('<table><tr><th>Карта</th><th>Матчей</th></tr>');
    expect(html).toContain('<td><tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> Ascent</td><td align="right">12</td>');
    // Unknown map → no emoji prefix.
    expect(html).toContain('<td>UnknownMap</td><td align="right">3</td>');
    expect(html).toContain('<h3>🎭 Чаще всего пикали</h3>');
    expect(html).toContain('<table><tr><th>Агент</th><th>Пиков</th></tr>');
    expect(html).toContain('<td><tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> Jett</td><td align="right">15</td>');
  });

  it('ends with the <footer>#digest</footer>', () => {
    const html = renderRichDigest(fullModel());
    expect(html.endsWith('<footer>#digest</footer>')).toBe(true);
  });

  it('never emits a raw newline', () => {
    const html = renderRichDigest(fullModel());
    expect(html).not.toContain('\n');
  });

  it('omits every optional section when empty (only title, pulse, footer remain)', () => {
    const html = renderRichDigest(
      fullModel({
        coverMap: null,
        records: [],
        winstreaks: [],
        promotions: [],
        weaponMasters: [],
        nearMisses: [],
        topMaps: [],
        topAgents: [],
        mostActive: null,
      }),
    );
    expect(html).not.toContain('<h3>');
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('<table striped>');
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Больше всех матчей');
    expect(html).not.toContain('Винстрик недели');
    // Still has the title, pulse, and footer.
    expect(html).toContain('<h2>📅 Дайджест за неделю');
    expect(html).toContain('📊 За неделю мы сыграли <b>42</b> матчей');
    expect(html.endsWith('<footer>#digest</footer>')).toBe(true);
    expect(html).not.toContain('\n');
  });

  it('escapes plain text (map/agent/weapon/record names) but keeps trusted player HTML', () => {
    const html = renderRichDigest(
      fullModel({
        topMaps: [{ emojiHtml: '', map: 'A<b>X</b>', count: 1 }],
        weaponMasters: [
          { weaponEmojiHtml: '🎯', weapon: 'W&W', value: 5, playerHtml: '<b>Safe#TAG</b>' },
        ],
      }),
    );
    expect(html).toContain('<td>A&lt;b&gt;X&lt;/b&gt;</td><td align="right">1</td>');
    expect(html).toContain('<td>🎯 W&amp;W</td><td align="right">5</td><td><b>Safe#TAG</b></td>');
  });
});
