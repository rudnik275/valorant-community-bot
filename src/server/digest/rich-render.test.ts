import { describe, it, expect } from 'vitest';
import { renderRichDigest, type RichDigestModel } from './rich-render.ts';

/** A fully-populated model exercising every section. */
function fullModel(overrides: Partial<RichDigestModel> = {}): RichDigestModel {
  return {
    headerDate: '27 апреля 2025 г.',
    brightBlocks: [
      '🏆 <u>Винстрик недели:</u>\n<b>Alpha#AAA</b> — 12 побед подряд',
      '💀 <u>Серийный маньяк</u>\n<i>рекорд по количеству фрагов за игру</i>\n<b>Killer#KLL</b> — 38 фрагов',
    ],
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
    nearMissBlocks: [
      '💀 <u>Был(ла) близко к рекорду по киллам</u>\n<b>NearMisser#NM</b> — 29 фрагов',
    ],
    totalMatches: 42,
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

describe('renderRichDigest', () => {
  it('renders the title as an <h2> with the date', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h2>📅 Дайджест за неделю · 27 апреля 2025 г.</h2>');
  });

  it('renders section headings as <h3>', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<h3>🔫 Мастера своего дела</h3>');
    expect(html).toContain('<h3>🗺 Чаще всего играли на</h3>');
    expect(html).toContain('<h3>🎭 Чаще всего пикали</h3>');
  });

  it('renders top-maps as a table (Карта | Матчей) with the count cells', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<table><tr><th>Карта</th><th>Матчей</th></tr>');
    expect(html).toContain('<td><tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> Ascent</td><td>12</td>');
    // Unknown map → no emoji prefix.
    expect(html).toContain('<td>UnknownMap</td><td>3</td>');
  });

  it('renders top-agents as a table (Агент | Пиков)', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<table><tr><th>Агент</th><th>Пиков</th></tr>');
    expect(html).toContain('<td><tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> Jett</td><td>15</td>');
  });

  it('renders «Мастера своего дела» as a table (Оружие | Фраги | Игрок) with emoji + player in cells', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<table><tr><th>Оружие</th><th>Фраги</th><th>Игрок</th></tr>');
    expect(html).toContain(
      '<td><tg-emoji emoji-id="5267384313137108259">🔫</tg-emoji> Vandal</td><td>24</td><td><b>Alpha#AAA</b></td>',
    );
    expect(html).toContain(
      '<td><tg-emoji emoji-id="5267421855446243759">🔫</tg-emoji> Phantom</td><td>18</td><td><b>Beta#BBB</b></td>',
    );
  });

  it('wraps the near-miss block in a collapsible <details><summary>💨 Почти рекорды</summary>', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('<details><summary>💨 Почти рекорды</summary>');
    expect(html).toContain('</details>');
    // The near-miss content is inside, with its newline converted.
    expect(html).toContain('Был(ла) близко к рекорду по киллам</u><br><b>NearMisser#NM</b> — 29 фрагов');
  });

  it('keeps the #digest footer', () => {
    const html = renderRichDigest(fullModel());
    expect(html.endsWith('#digest')).toBe(true);
  });

  it('renders the pulse line and most-active line', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('📊 За неделю мы сыграли <b>42</b> матчей');
    expect(html).toContain('🏆 Больше всех матчей<br><b>Alpha#AAA</b> - 7 за неделю');
  });

  it('converts every raw newline in bright blocks to <br> (no raw \\n anywhere)', () => {
    const html = renderRichDigest(fullModel());
    expect(html).not.toContain('\n');
    // bright block newline became <br>
    expect(html).toContain('🏆 <u>Винстрик недели:</u><br><b>Alpha#AAA</b> — 12 побед подряд');
  });

  it('joins multiple bright blocks with a blank line (<br><br>)', () => {
    const html = renderRichDigest(fullModel());
    expect(html).toContain('12 побед подряд<br><br>💀 <u>Серийный маньяк</u>');
  });

  it('omits sections that are empty (no maps/agents/weapons/near-miss/most-active)', () => {
    const html = renderRichDigest(
      fullModel({
        brightBlocks: [],
        weaponMasters: [],
        nearMissBlocks: [],
        topMaps: [],
        topAgents: [],
        mostActive: null,
      }),
    );
    expect(html).not.toContain('<h3>');
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('Больше всех матчей');
    // Still has the title, pulse, and footer.
    expect(html).toContain('<h2>📅 Дайджест за неделю');
    expect(html).toContain('📊 За неделю мы сыграли <b>42</b> матчей');
    expect(html.endsWith('#digest')).toBe(true);
    expect(html).not.toContain('\n');
  });

  it('escapes plain text in table cells (map/agent/weapon names) but keeps trusted player HTML', () => {
    const html = renderRichDigest(
      fullModel({
        topMaps: [{ emojiHtml: '', map: 'A<b>X</b>', count: 1 }],
        weaponMasters: [
          { weaponEmojiHtml: '🎯', weapon: 'W&W', value: 5, playerHtml: '<b>Safe#TAG</b>' },
        ],
      }),
    );
    // map name escaped
    expect(html).toContain('<td>A&lt;b&gt;X&lt;/b&gt;</td><td>1</td>');
    // weapon name escaped, player html trusted (kept as-is)
    expect(html).toContain('<td>🎯 W&amp;W</td><td>5</td><td><b>Safe#TAG</b></td>');
  });
});
