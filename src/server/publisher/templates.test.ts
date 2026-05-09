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

  it('rank_promo: shows from and to', () => {
    const output = renderTemplate('rank_promo', { from: 'Gold 1', to: 'Gold 2' }, safeUser);
    expect(output).toContain('Gold 1');
    expect(output).toContain('Gold 2');
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
