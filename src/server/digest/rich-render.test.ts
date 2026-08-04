import { describe, it, expect } from 'vitest';
import { renderDigest, mapSplashUrl, type RichDigestModel } from './rich-render.ts';

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
    aces: [
      { name: 'Killer', tag: 'KLL', count: 4 },
      { name: 'Alpha', tag: 'AAA', count: 2 },
    ],
    knives: [
      { name: 'Alpha', tag: 'AAA', count: 3 },
      { name: 'Beta', tag: 'BBB', count: 1 },
    ],
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

/** An otherwise-empty model — only the always-present pulse line survives. */
function emptyModel(overrides: Partial<RichDigestModel> = {}): RichDigestModel {
  return {
    headerDate: '1 мая 2025 г.',
    coverMap: null,
    totalMatches: 3,
    records: [],
    winstreaks: [],
    aces: [],
    knives: [],
    promotions: [],
    weaponMasters: [],
    nearMisses: [],
    mostActive: null,
    topMaps: [],
    topAgents: [],
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

describe('renderDigest — no tables anywhere (the whole point of the 2026-08 rewrite)', () => {
  it('emits no <table>/<tr>/<td>/<th> in either rendering', () => {
    const { html, text } = renderDigest(fullModel());
    for (const out of [html, text]) {
      expect(out).not.toMatch(/<table/);
      expect(out).not.toMatch(/<tr>/);
      expect(out).not.toMatch(/<t[dh]/);
    }
  });

  it('emits no <details>/<summary> accordions', () => {
    const { html, text } = renderDigest(fullModel());
    for (const out of [html, text]) {
      expect(out).not.toMatch(/<details>/);
      expect(out).not.toMatch(/<summary>/);
    }
  });
});

describe('renderDigest — html rendering', () => {
  it('renders the title as an <h2> with the date', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('<h2>📅 Дайджест за неделю · 27 апреля 2025 г.</h2>');
  });

  it('renders the cover splash when the top map is known, and omits it otherwise', () => {
    expect(renderDigest(fullModel()).html).toContain(
      '<img src="https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png">',
    );
    expect(renderDigest(fullModel({ coverMap: null })).html).not.toContain('<img');
    expect(renderDigest(fullModel({ coverMap: 'NotAMap' })).html).not.toContain('<img');
  });

  it('carries NO raw newline — rich clients collapse them browser-style', () => {
    expect(renderDigest(fullModel()).html).not.toContain('\n');
    expect(renderDigest(emptyModel()).html).not.toContain('\n');
  });

  it('ends with the #digest footer', () => {
    expect(renderDigest(fullModel()).html).toContain('<footer>#digest</footer>');
  });
});

describe('renderDigest — ace / knife leaderboards', () => {
  it('renders «кто сколько эйсов сделал» with podium medals and counts', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🎯 <b>Эйсы недели</b>');
    expect(html).toContain('🥇 <b>Killer#KLL</b> — 4');
    expect(html).toContain('🥈 <b>Alpha#AAA</b> — 2');
  });

  it('renders knife counts with no AFK/goose distinction — a knife kill is a knife kill', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🔪 <b>Ножи недели</b>');
    expect(html).toContain('🥇 <b>Alpha#AAA</b> — 3');
    expect(html).toContain('🥈 <b>Beta#BBB</b> — 1');
    expect(html).not.toContain('🪿');
    expect(html).not.toContain('гус');
    expect(html).not.toContain('баранчик');
  });

  it('falls back to a bullet past the podium', () => {
    const { html } = renderDigest(
      fullModel({
        aces: [
          { name: 'A', tag: 'T', count: 4 },
          { name: 'B', tag: 'T', count: 3 },
          { name: 'C', tag: 'T', count: 2 },
          { name: 'D', tag: 'T', count: 1 },
        ],
      }),
    );
    expect(html).toContain('🥉 <b>C#T</b> — 2');
    expect(html).toContain('• <b>D#T</b> — 1');
  });

  it('omits an empty board entirely', () => {
    const { html } = renderDigest(fullModel({ aces: [], knives: [] }));
    expect(html).not.toContain('Эйсы недели');
    expect(html).not.toContain('Ножи недели');
  });
});

describe('renderDigest — former table sections as flat lines', () => {
  it('renders weapon masters one line per weapon', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🔫 <b>Мастера своего дела</b>');
    expect(html).toContain(
      '<tg-emoji emoji-id="5267384313137108259">🔫</tg-emoji> Vandal · 24 — <b>Alpha#AAA</b>',
    );
  });

  it('renders promotions one line per player with an arrow to the rank', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🎖 <b>Повышение по службе</b>');
    expect(html).toContain('<b>Climber#UP</b> → ');
  });

  it('pluralises the promotions header for ≥2 players', () => {
    const { html } = renderDigest(
      fullModel({
        promotions: [
          { name: 'A', tag: 'T', rank: 'Platinum 1' },
          { name: 'B', tag: 'T', rank: 'Gold 3' },
        ],
      }),
    );
    expect(html).toContain('🎖 <b>Повышения по службе</b>');
  });

  it('renders maps as icon + name, agents as the icon alone', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain(
      '🗺 <b>Карты недели</b><br><br>🥇 <tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji> Ascent — 12<br>🥈 UnknownMap — 3',
    );
    // Agent icon REPLACES the name.
    expect(html).toContain('🎭 <b>Агенты недели</b><br><br>🥇 <tg-emoji emoji-id="5265124043647916479">🦸</tg-emoji> — 15');
    expect(html).not.toContain('🦸</tg-emoji> Jett');
  });

  it('falls back to the agent name when the pack has no icon for it', () => {
    // Newer agents (Waylay, Tejo, Veto…) are not in the pack — the row must
    // still say something rather than render blank.
    const { html } = renderDigest(fullModel({ topAgents: [{ emojiHtml: '', agent: 'Waylay', count: 1 }] }));
    expect(html).toContain('🥇 Waylay — 1');
  });

  it('keeps the map name when the pack has no icon for that map', () => {
    const { html } = renderDigest(fullModel({ topMaps: [{ emojiHtml: '', map: 'District', count: 2 }] }));
    expect(html).toContain('🥇 District — 2');
  });

  it('shows every entry, not a top-3 slice, with a bullet past the podium', () => {
    const { html } = renderDigest(
      fullModel({
        topMaps: [
          { emojiHtml: '', map: 'A', count: 5 },
          { emojiHtml: '', map: 'B', count: 4 },
          { emojiHtml: '', map: 'C', count: 3 },
          { emojiHtml: '', map: 'D', count: 2 },
          { emojiHtml: '', map: 'E', count: 1 },
        ],
      }),
    );
    expect(html).toContain('🥉 C — 3');
    expect(html).toContain('• D — 2');
    expect(html).toContain('• E — 1');
  });

  it('links the match on weapon-master rows — a per-match record', () => {
    const { html } = renderDigest(
      fullModel({
        weaponMasters: [{
          weaponEmojiHtml: '🔫',
          weapon: 'Sheriff',
          value: 22,
          playerHtml: '<b>Sniper#SNP</b>',
          matchUrl: 'https://tracker.gg/valorant/match/w-1',
          mapName: 'Bind',
        }],
      }),
    );
    expect(html).toContain('🔫 Sheriff · 22 — <b>Sniper#SNP</b> · ');
    expect(html).toContain('<a href="https://tracker.gg/valorant/match/w-1">Bind</a>');
  });

  it('links the match on a near-miss too', () => {
    const { html } = renderDigest(
      fullModel({
        nearMisses: [{
          emoji: '💀',
          header: 'Был(ла) близко к рекорду по киллам',
          player: { name: 'NearMisser', tag: 'NM', agent: 'Sova' },
          value: '29 фрагов',
          matchUrl: 'https://tracker.gg/valorant/match/nm-1',
          mapName: 'Lotus',
        }],
      }),
    );
    expect(html).toContain('<a href="https://tracker.gg/valorant/match/nm-1">Lotus</a>');
  });

  it('omits the link when a row has no match attached', () => {
    const { html } = renderDigest(fullModel());
    // Default fixtures carry no matchUrl on weapons / near-miss.
    expect(html).toContain('Vandal · 24 — <b>Alpha#AAA</b>');
  });
});

describe('renderDigest — collapsed map/agent tail', () => {
  const maps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ emojiHtml: '', map: `M${i + 1}`, count: n - i }));

  it('keeps the podium visible and folds the rest into a <details>', () => {
    const { html } = renderDigest(fullModel({ topMaps: maps(7) }));
    expect(html).toContain('🗺 <b>Карты недели</b><br><br>🥇 M1 — 7<br>🥈 M2 — 6<br>🥉 M3 — 5');
    expect(html).toContain('<details><summary>ещё 4 карты</summary>• M4 — 4<br>• M5 — 3<br>• M6 — 2<br>• M7 — 1</details>');
  });

  it('never renders an empty accordion — at any board size from 0 to 6', () => {
    for (let n = 0; n <= 6; n++) {
      const { html } = renderDigest(
        fullModel({ topMaps: maps(n), topAgents: [], aces: [], knives: [] }),
      );
      expect(html, `board of ${n}`).not.toContain('<summary></summary>');
      expect(html, `board of ${n}`).not.toContain('<details></details>');
      // An accordion exists only once there are at least two rows to hide.
      const hasAccordion = html.includes('<details>');
      expect(hasAccordion, `board of ${n}`).toBe(n > 4);
      if (hasAccordion) {
        const inner = /<summary>[^<]*<\/summary>(.*?)<\/details>/.exec(html)?.[1] ?? '';
        expect(inner.length, `board of ${n} must hide something`).toBeGreaterThan(0);
      }
    }
  });

  it('does not open an accordion for a tail of one — it would cost more than it saves', () => {
    const { html } = renderDigest(fullModel({ topMaps: maps(4) }));
    expect(html).not.toContain('<details>');
    expect(html).toContain('• M4 — 1');
  });

  it('leaves a board of 3 or fewer completely alone', () => {
    const { html } = renderDigest(fullModel({ topMaps: maps(3), topAgents: [] }));
    expect(html).not.toContain('<details>');
    expect(html).toContain('🥉 M3 — 1');
  });

  it('declines the Russian plural in the summary', () => {
    const sum = (n: number) => {
      const { html } = renderDigest(fullModel({ topMaps: maps(3 + n) }));
      return /<summary>([^<]*)<\/summary>/.exec(html)?.[1];
    };
    expect(sum(2)).toBe('ещё 2 карты');
    expect(sum(5)).toBe('ещё 5 карт');
    expect(sum(11)).toBe('ещё 11 карт');
    expect(sum(21)).toBe('ещё 21 карта');
  });

  it('collapses agents with their own noun', () => {
    const { html } = renderDigest(
      fullModel({
        topAgents: Array.from({ length: 28 }, (_, i) => ({ emojiHtml: '', agent: `A${i + 1}`, count: 28 - i })),
      }),
    );
    expect(html).toContain('<summary>ещё 25 агентов</summary>');
    expect(html).toContain('🥇 A1 — 28');
    expect(html).toContain('• A28 — 1');
  });

  it('the text twin has no accordion and lists every row', () => {
    const { text } = renderDigest(fullModel({ topMaps: maps(7) }));
    expect(text).not.toContain('<details>');
    expect(text).not.toContain('<summary>');
    expect(text).toContain('🥇 M1 — 7');
    expect(text).toContain('• M7 — 1');
  });

  it('ace and knife boards collapse the same way, counting игроков', () => {
    const { html } = renderDigest(
      fullModel({
        aces: Array.from({ length: 8 }, (_, i) => ({ name: `P${i + 1}`, tag: 'T', count: 8 - i })),
      }),
    );
    expect(html).toContain('🎯 <b>Эйсы недели</b><br><br>🥇 <b>P1#T</b> — 8<br>🥈 <b>P2#T</b> — 7<br>🥉 <b>P3#T</b> — 6');
    expect(html).toContain('<summary>ещё 5 игроков</summary>');
    expect(html).toContain('• <b>P8#T</b> — 1');
  });

  it('a short ace board is left open — 3 players, no accordion', () => {
    const { html } = renderDigest(fullModel({ aces: [
      { name: 'A', tag: 'T', count: 3 },
      { name: 'B', tag: 'T', count: 2 },
      { name: 'C', tag: 'T', count: 1 },
    ], knives: [], topMaps: [], topAgents: [] }));
    expect(html).not.toContain('<details>');
  });

  it('the knife board collapses independently of the ace board', () => {
    const { html } = renderDigest(
      fullModel({
        aces: [{ name: 'Solo', tag: 'T', count: 1 }],
        knives: Array.from({ length: 5 }, (_, i) => ({ name: `K${i + 1}`, tag: 'T', count: 5 - i })),
        topMaps: [],
        topAgents: [],
      }),
    );
    // One accordion in the whole digest, and it belongs to the knife board.
    expect(html.match(/<details>/g)).toHaveLength(1);
    expect(html).toContain('<summary>ещё 2 игрока</summary>');
    const aceIdx = html.indexOf('🎯 <b>Эйсы недели</b>');
    const knifeIdx = html.indexOf('🔪 <b>Ножи недели</b>');
    expect(html.slice(aceIdx, knifeIdx)).not.toContain('<details>');
  });
});

describe('renderDigest — section order', () => {
  it('follows the owner-specified sequence', () => {
    const { html } = renderDigest(fullModel());
    const order = [
      'мы сыграли',                    // пульс
      'Больше всех матчей',
      'Винстрик недели',
      'Серийный маньяк',               // рекорды
      'Был(ла) близко к рекорду',      // почти рекорды
      'Повышение по службе',
      'Мастера своего дела',
      'Эйсы недели',
      'Ножи недели',
      'Карты недели',
      'Агенты недели',
      '#digest',
    ];
    const positions = order.map((marker) => {
      const at = html.indexOf(marker);
      expect(at, `section "${marker}" must be present`).toBeGreaterThan(-1);
      return at;
    });
    // Strictly increasing ⇒ the rendered order matches the list above.
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i]!,
        `"${order[i]}" must come after "${order[i - 1]}"`,
      ).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('keeps the order stable when optional sections drop out', () => {
    const { html } = renderDigest(fullModel({ winstreaks: [], promotions: [], nearMisses: [] }));
    const seq = ['Больше всех матчей', 'Серийный маньяк', 'Мастера своего дела', 'Эйсы недели', 'Карты недели'];
    const pos = seq.map((m) => html.indexOf(m));
    expect(pos.every((p) => p > -1)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });
});

describe('renderDigest — section spacing', () => {
  it('puts a blank line between a header and its body', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🎯 <b>Эйсы недели</b><br><br>🥇');
    expect(html).toContain('🏆 <b>Больше всех матчей</b><br><br>');
  });

  it('puts the blank line AFTER the description, keeping it with the header', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain(
      '🔫 <b>Мастера своего дела</b><br><i>лидеры по убийствам одним оружием за матч</i><br><br>',
    );
    // …and NOT between the header and its description.
    expect(html).not.toContain('🔫 <b>Мастера своего дела</b><br><br><i>');
  });

  it('does not stack a blank line on top of an accordion — <details> brings its own', () => {
    const { html } = renderDigest(
      fullModel({ topMaps: Array.from({ length: 7 }, (_, i) => ({ emojiHtml: '', map: `M${i}`, count: 7 - i })) }),
    );
    expect(html).toContain('</details>');
    expect(html).not.toContain('</details><br><br>');
  });

  it('still separates two plain sections with a blank line', () => {
    const { html } = renderDigest(fullModel({ aces: [], knives: [], topMaps: [], topAgents: [] }));
    expect(html).toContain('матчей<br><br>');
  });

  it('the pulse line is standalone — no blank line glued under it', () => {
    const { html } = renderDigest(fullModel());
    expect(html).not.toContain('матчей<br><br><br>');
  });

  it('the text twin mirrors the spacing with real newlines', () => {
    const { text } = renderDigest(fullModel());
    expect(text).toContain('🎯 <b>Эйсы недели</b>\n\n🥇');
    expect(text).toContain('<i>лидеры по убийствам одним оружием за матч</i>\n\n');
  });
});

describe('renderDigest — records', () => {
  it('renders a record as a title line plus a nick · value · match-link line', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('💀 <b>Серийный маньяк</b>');
    expect(html).toContain('38 фрагов');
    expect(html).toContain('href="https://tracker.gg/valorant/match/m-kills"');
  });

  it('omits the match link for aggregate records that have no single match', () => {
    const { html } = renderDigest(
      fullModel({
        records: [
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
      }),
    );
    expect(html).toContain('👑 <b>Король MVP за неделю</b>');
    expect(html).not.toContain('<a href=');
  });
});

describe('renderDigest — the text twin', () => {
  it('contains the same sections as the html, with real newlines', () => {
    const { text } = renderDigest(fullModel());
    expect(text).toContain('📅 <b>Дайджест за неделю · 27 апреля 2025 г.</b>');
    expect(text).toContain('📊 За неделю мы сыграли <b>42</b> матчей');
    expect(text).toContain('🎯 <b>Эйсы недели</b>\n\n🥇 <b>Killer#KLL</b> — 4');
    expect(text).toContain('🔪 <b>Ножи недели</b>');
    expect(text).toContain('🔫 <b>Мастера своего дела</b>');
    expect(text).toMatch(/#digest$/);
  });

  it('carries no <br> — that is html-only chrome', () => {
    expect(renderDigest(fullModel()).text).not.toContain('<br>');
  });

  it('omits html-only chrome (h2 heading tag, cover image, footer tag)', () => {
    const { text } = renderDigest(fullModel());
    expect(text).not.toContain('<h2>');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('<footer>');
  });

  it('never drifts from the html: every section header present in one is in the other', () => {
    const { html, text } = renderDigest(fullModel());
    for (const header of [
      'Эйсы недели',
      'Ножи недели',
      'Винстрик недели',
      'Мастера своего дела',
      'Повышение по службе',
      'Больше всех матчей',
      'Серийный маньяк',
    ]) {
      expect(html).toContain(header);
      expect(text).toContain(header);
    }
  });
});

describe('renderDigest — empty sections', () => {
  it('renders just the pulse line when nothing else qualifies', () => {
    const { html, text } = renderDigest(emptyModel());
    expect(html).toContain('📊 За неделю мы сыграли <b>3</b> матчей');
    expect(text).toContain('📊 За неделю мы сыграли <b>3</b> матчей');
    for (const header of ['Эйсы недели', 'Ножи недели', 'Мастера своего дела', 'Больше всех матчей']) {
      expect(html).not.toContain(header);
    }
  });
});

describe('renderDigest — escaping', () => {
  it('escapes hostile nicks and record titles', () => {
    const { html } = renderDigest(
      fullModel({
        aces: [{ name: '<script>', tag: '&evil', count: 1 }],
        records: [
          {
            emoji: '💀',
            title: '<b>pwn</b>',
            player: { name: 'A', tag: 'T', rank: null, agent: null },
            value: '1 & 2',
            matchUrl: null,
            mapName: null,
            context: 'ctx',
          },
        ],
      }),
    );
    expect(html).toContain('&lt;script&gt;#&amp;evil');
    expect(html).toContain('&lt;b&gt;pwn&lt;/b&gt;');
    expect(html).toContain('1 &amp; 2');
    expect(html).not.toContain('<script>');
  });
});
