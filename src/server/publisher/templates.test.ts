import { describe, it, expect } from 'vitest';
import { renderTemplate, esc } from './templates.ts';
import type { EventType } from './types.ts';

const ALL_EVENT_TYPES: EventType[] = [
  'ace',
  'ace_rare_weapon',
  'clutch_1vN',
  'rank_promo',
  'winstreak_9',
  'giant_slayer',
  'comeback',
  'lostrick_9',
  'teamkill',
  'fall_damage_death',
  'zero_match',
];

const safeUser = {
  riot_name: 'Player',
  riot_tag: 'TAG',
  telegram_id: 12345,
};

const injectionUser = {
  riot_name: '<script>alert(1)</script>',
  riot_tag: '<img>',
  telegram_id: 99999,
};

const minimalPayloads: Record<EventType, Record<string, unknown>> = {
  ace: {},
  ace_rare_weapon: {},
  clutch_1vN: {},
  rank_promo: {},
  winstreak_9: {},
  giant_slayer: {},
  comeback: {},
  lostrick_9: {},
  teamkill: {},
  fall_damage_death: {},
  zero_match: {},
};

describe('esc()', () => {
  it('escapes < > & " \'', () => {
    expect(esc('<script>&"\'</script>')).toBe('&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  });

  it('passes through normal strings', () => {
    expect(esc('Player#TAG')).toBe('Player#TAG');
  });
});

describe('renderTemplate — all event types render without throwing', () => {
  for (const eventType of ALL_EVENT_TYPES) {
    it(`renders ${eventType} with minimal payload`, () => {
      expect(() => renderTemplate(eventType, minimalPayloads[eventType]!, safeUser)).not.toThrow();
    });

    it(`${eventType} output does not contain unescaped <`, () => {
      const output = renderTemplate(eventType, minimalPayloads[eventType]!, safeUser);
      // Allow <b> and </b> tags (intentional HTML), but no raw < from user input
      // Strip out allowed HTML tags, then check no < remains
      const stripped = output.replace(/<\/?b>/g, '');
      expect(stripped).not.toContain('<');
    });
  }
});

describe('renderTemplate — HTML injection prevention', () => {
  it('escapes <script> in riot_name for ace', () => {
    const output = renderTemplate('ace', {}, injectionUser);
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).not.toContain('<script>');
  });

  it('escapes <script> in riot_name for all event types', () => {
    for (const eventType of ALL_EVENT_TYPES) {
      const output = renderTemplate(eventType, minimalPayloads[eventType]!, injectionUser);
      expect(output).not.toContain('<script>');
      expect(output).not.toContain('<img>');
    }
  });
});

describe('renderTemplate — payload-specific behavior', () => {
  it('ace: shows round count when multiple rounds present', () => {
    const output = renderTemplate('ace', { rounds: [1, 2, 3] }, safeUser);
    expect(output).toContain('3×');
  });

  it('ace: includes map from match param', () => {
    const output = renderTemplate('ace', {}, safeUser, { map: 'Ascent' });
    expect(output).toContain('Ascent');
  });

  it('ace_rare_weapon: shows weapons', () => {
    const output = renderTemplate('ace_rare_weapon', { weapons: ['Odin', 'Ares'] }, safeUser);
    expect(output).toContain('Odin');
    expect(output).toContain('Ares');
  });

  it('clutch_1vN: uses n from payload', () => {
    const output = renderTemplate('clutch_1vN', { n: 3 }, safeUser);
    expect(output).toContain('1v3');
  });

  it('clutch_1vN: falls back to kills if n missing', () => {
    const output = renderTemplate('clutch_1vN', { kills: 4 }, safeUser);
    expect(output).toContain('1v4');
  });

  it('rank_promo: shows from and to with апнул wording', () => {
    const output = renderTemplate('rank_promo', { from: 'Gold 1', to: 'Gold 2' }, safeUser);
    expect(output).toContain('Gold 1');
    expect(output).toContain('Gold 2');
    expect(output).toContain('апнул ранг');
    expect(output).not.toContain('обновил');
  });

  it('rank_promo: to-only branch uses апнул wording', () => {
    const output = renderTemplate('rank_promo', { to: 'Ascendant 1' }, safeUser);
    expect(output).toContain('Ascendant 1');
    expect(output).toContain('апнул ранг');
    expect(output).not.toContain('обновил');
  });

  it('rank_promo: no-payload branch uses апнул wording', () => {
    const output = renderTemplate('rank_promo', {}, safeUser);
    expect(output).toContain('апнул ранг');
    expect(output).not.toContain('обновил');
  });

  it('rank_promo: Diamond 3 → Ascendant 1 contains emoji tags for both ranks', () => {
    const output = renderTemplate('rank_promo', { from: 'Diamond 3', to: 'Ascendant 1' }, safeUser);
    expect(output).toContain('<tg-emoji emoji-id="5190612593059864801">💎</tg-emoji> Diamond 3');
    expect(output).toContain('<tg-emoji emoji-id="5188550815484256589">💚</tg-emoji> Ascendant 1');
    expect(output).toContain(' → ');
    expect(output).toMatch(/!$/);
  });

  it('rank_promo: to-only with Immortal 1 contains emoji tag', () => {
    const output = renderTemplate('rank_promo', { to: 'Immortal 1' }, safeUser);
    expect(output).toContain('теперь <tg-emoji emoji-id="5188459714932943688">🔮</tg-emoji> Immortal 1!');
  });

  it('rank_promo: no-payload still produces апнул ранг! with no icon or extra spaces', () => {
    const output = renderTemplate('rank_promo', {}, safeUser);
    expect(output).toContain('апнул ранг!');
    expect(output).not.toContain('<tg-emoji');
    expect(output).not.toContain('  ');
  });

  it('rank_promo: unknown rank label renders plain text without broken tg-emoji', () => {
    const output = renderTemplate('rank_promo', { to: 'MetaTier 1' }, safeUser);
    expect(output).toContain('теперь MetaTier 1!');
    expect(output).not.toContain('<tg-emoji');
  });

  it('winstreak_9: shows streak count', () => {
    const output = renderTemplate('winstreak_9', { streak: 9 }, safeUser);
    expect(output).toContain('9');
  });

  it('giant_slayer: shows enemy avg rank', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1', delta: 2 }, safeUser);
    expect(output).toContain('Platinum 1');
  });

  it('comeback: shows days_paused', () => {
    const output = renderTemplate('comeback', { days_paused: 14 }, safeUser);
    expect(output).toContain('14');
  });

  it('lostrick_9: shows streak count', () => {
    const output = renderTemplate('lostrick_9', { streak: 9 }, safeUser);
    expect(output).toContain('9');
  });

  it('teamkill: shows round count from round_numbers', () => {
    const output = renderTemplate('teamkill', { round_numbers: [3, 7, 12] }, safeUser);
    expect(output).toContain('3×');
  });

  it('fall_damage_death: includes map', () => {
    const output = renderTemplate('fall_damage_death', { count: 2 }, safeUser, { map: 'Icebox' });
    expect(output).toContain('Icebox');
  });

  it('zero_match: shows round count', () => {
    const output = renderTemplate('zero_match', { rounds: 24, deaths: 15 }, safeUser);
    expect(output).toContain('24');
  });

  it('ace_rare_weapon: weapons are HTML-escaped', () => {
    const output = renderTemplate('ace_rare_weapon', { weapons: ['<Odin>'] }, safeUser);
    expect(output).not.toContain('<Odin>');
    expect(output).toContain('&lt;Odin&gt;');
  });
});

// ─── opponents_peak rendering ─────────────────────────────────────────────────

describe('renderTemplate — opponents_peak in ace and clutch_1vN', () => {
  const victims = [
    { puuid: 'p1', name: 'Pink', tag: '1234' },
    { puuid: 'p2', name: 'El Bicho', tag: '5678' },
    { puuid: 'p3', name: 'DarkAngel', tag: 'EU1' },
  ];

  const fullPeak = {
    p1: { tier_id: 19, tier_name: 'Diamond 2', season_short: 'e9' },
    p2: { tier_id: 21, tier_name: 'Ascendant 1', season_short: 'e9' },
    p3: { tier_id: 24, tier_name: 'Immortal 3', season_short: 'e8' },
  };

  it('ace: renders all opponents with peak ranks when fully present', () => {
    const output = renderTemplate('ace', {
      rounds: [3],
      victims,
      victim_names_for_template: ['Pink', 'El Bicho', 'DarkAngel'],
      opponents_peak: fullPeak,
    }, safeUser);

    expect(output).toContain('Жертвы:');
    expect(output).toContain('Pink (peak Diamond 2)');
    expect(output).toContain('El Bicho (peak Ascendant 1)');
    expect(output).toContain('DarkAngel (peak Immortal 3)');
  });

  it('ace: renders opponents without peak when opponents_peak is partially missing', () => {
    const partialPeak = {
      p1: { tier_id: 19, tier_name: 'Diamond 2', season_short: 'e9' },
      // p2 and p3 missing
    };

    const output = renderTemplate('ace', {
      rounds: [3],
      victims,
      victim_names_for_template: ['Pink', 'El Bicho', 'DarkAngel'],
      opponents_peak: partialPeak,
    }, safeUser);

    expect(output).toContain('Pink (peak Diamond 2)');
    // p2/p3 have names but no peak — should render name only
    expect(output).toContain('El Bicho');
    expect(output).not.toContain('El Bicho (peak');
  });

  it('ace: does NOT render Жертвы section when opponents_peak is empty', () => {
    const output = renderTemplate('ace', {
      rounds: [3],
      victims,
      victim_names_for_template: ['Pink', 'El Bicho', 'DarkAngel'],
      opponents_peak: {},
    }, safeUser);

    expect(output).not.toContain('Жертвы');
    // Base message should still render
    expect(output).toContain('Эйс');
  });

  it('ace: does NOT render Жертвы section when opponents_peak is absent', () => {
    const output = renderTemplate('ace', { rounds: [3] }, safeUser);
    expect(output).not.toContain('Жертвы');
  });

  it('ace: opponents peak names are HTML-escaped', () => {
    const output = renderTemplate('ace', {
      rounds: [1],
      victims: [{ puuid: 'p-evil', name: '<script>xss</script>', tag: '' }],
      victim_names_for_template: ['<script>xss</script>'],
      opponents_peak: {
        'p-evil': { tier_id: 19, tier_name: '<Diamond>', season_short: 'e9' },
      },
    }, safeUser);

    expect(output).not.toContain('<script>');
    expect(output).not.toContain('<Diamond>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('&lt;Diamond&gt;');
  });

  it('clutch_1vN: renders Жертвы section with peak ranks', () => {
    const output = renderTemplate('clutch_1vN', {
      rounds: [{ round: 5, kills: 3 }],
      n: 3,
      victims: victims.slice(0, 2),
      victim_names_for_template: ['Pink', 'El Bicho'],
      opponents_peak: {
        p1: { tier_id: 19, tier_name: 'Diamond 2', season_short: 'e9' },
        p2: { tier_id: 21, tier_name: 'Ascendant 1', season_short: 'e9' },
      },
    }, safeUser);

    expect(output).toContain('Клатч');
    expect(output).toContain('Жертвы:');
    expect(output).toContain('Pink (peak Diamond 2)');
    expect(output).toContain('El Bicho (peak Ascendant 1)');
  });

  it('clutch_1vN: renders without Жертвы when opponents_peak absent', () => {
    const output = renderTemplate('clutch_1vN', { n: 3 }, safeUser);
    expect(output).not.toContain('Жертвы');
    expect(output).toContain('Клатч');
  });

  it('ace: renders only peak when victim name is empty string', () => {
    const output = renderTemplate('ace', {
      rounds: [1],
      victims: [{ puuid: 'p-noname', name: '', tag: '' }],
      victim_names_for_template: [''],
      opponents_peak: {
        'p-noname': { tier_id: 21, tier_name: 'Ascendant 2', season_short: 'e9' },
      },
    }, safeUser);

    // Name is empty → should render just the peak rank
    expect(output).toContain('peak Ascendant 2');
  });

  it('ace: skips victim entirely when both name and peak are absent', () => {
    const output = renderTemplate('ace', {
      rounds: [1],
      victims: [
        { puuid: 'p-skip', name: '', tag: '' },
        { puuid: 'p-ok', name: 'Player', tag: '' },
      ],
      victim_names_for_template: ['', 'Player'],
      opponents_peak: {
        'p-ok': { tier_id: 18, tier_name: 'Diamond 1', season_short: 'e9' },
        // p-skip has no peak and no name → should be omitted
      },
    }, safeUser);

    expect(output).toContain('Player (peak Diamond 1)');
    // The total Жертвы line should only have 1 entry
    const match = output.match(/Жертвы: (.+)/);
    expect(match).not.toBeNull();
    // Should not have a trailing comma or extra commas
    expect(match![1]).not.toContain(',,');
  });
});
