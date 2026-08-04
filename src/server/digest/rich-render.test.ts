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
      { map: 'Ascent', count: 12 },
      { map: 'UnknownMap', count: 3 },
    ],
    topAgents: [{ agent: 'Jett', count: 15 }],
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

  it('collapses top maps and top agents into one inline line each', () => {
    const { html } = renderDigest(fullModel());
    expect(html).toContain('🗺 Ascent 12 · UnknownMap 3');
    expect(html).toContain('🎭 Jett 15');
  });

  it('does not repeat a per-entry icon on the maps/agents recap lines', () => {
    // The leading 🗺 / 🎭 labels the row; per-entry pack icons here rendered as
    // a doubled emoji, so they are dropped on these two lines only.
    const { html } = renderDigest(fullModel());
    expect(html).not.toContain('🗺 <tg-emoji');
    expect(html).not.toContain('🎭 <tg-emoji');
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
    expect(text).toContain('🎯 <b>Эйсы недели</b>\n🥇 <b>Killer#KLL</b> — 4');
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
