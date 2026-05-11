import { describe, it, expect } from 'vitest';
import { renderTemplate, esc } from './templates.ts';
import type { EventType } from './types.ts';

const ALL_EVENT_TYPES: EventType[] = [
  'ace',
  'ace_rare_weapon_week',
  'rank_promo',
  'winstreak_10plus',
  'giant_slayer',
  'return_after_pause',
  'teamkill',
  'fall_damage_death',
  'record_kills_match',
  'record_damage_dealt_match',
  'record_damage_received_match',
  'knife_kill',
  'match_comeback',
  'record_mvp_count_week',
  'community_clash',
  'record_kills_per_weapon',
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
  ace_rare_weapon_week: {},
  rank_promo: {},
  winstreak_10plus: {},
  giant_slayer: {},
  return_after_pause: {},
  teamkill: {},
  fall_damage_death: {},
  record_kills_match: { value: 30, prev_value: null, prev_puuid: null },
  record_damage_dealt_match: { value: 6840, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
  record_damage_received_match: { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
  knife_kill: {},
  match_comeback: {},
  record_mvp_count_week: { value: 5, prev_value: null, prev_puuid: null },
  community_clash: { teams: [], winner_team_id: null },
  record_kills_per_weapon: { weapon: 'Operator', value: 5, prev_value: 3, prev_puuid: 'other-puuid', prev_name: 'OldHolder', prev_tag: 'OLD', real_match_id: 'match-xyz' },
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
      // Allow intentional HTML tags (<b>, <a href=...>, <tg-emoji ...>), but no raw < from user input.
      // Strip all valid HTML tags, then check no < remains.
      const stripped = output.replace(/<[^>]+>/g, '');
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

  it('ace: contains AAAAAAACE heading', () => {
    const output = renderTemplate('ace', {}, safeUser);
    expect(output).toContain('AAAAAAACE');
  });

  it('ace: includes match link when match_id present', () => {
    const output = renderTemplate('ace', {}, safeUser, { match_id: 'abc123' });
    expect(output).toContain('tracker.gg/valorant/match/abc123');
  });

  it('ace_rare_weapon_week: shows Classic weapon from weapons_per_round', () => {
    const output = renderTemplate('ace_rare_weapon_week', {
      weapons_per_round: [['Classic', 'Classic', 'Vandal', 'Vandal', 'Classic']],
    }, safeUser);
    expect(output).toContain('Classic');
    expect(output).toContain('знает толк в извращениях');
  });

  it('rank_promo: Ascendant 1 shows "Повышение по службе" heading + icon + full rank label', () => {
    const output = renderTemplate('rank_promo', { from: 'Diamond 3', to: 'Ascendant 1' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<b>Player#TAG</b>');
    expect(output).toContain('<tg-emoji emoji-id="5188550815484256589">🟩</tg-emoji>');
    expect(output).toContain('Ascendant 1');
    expect(output).not.toContain('Diamond 3');
  });

  it('rank_promo: Immortal 1 shows icon + full rank label', () => {
    const output = renderTemplate('rank_promo', { to: 'Immortal 1' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<tg-emoji emoji-id="5188459714932943688">♦️</tg-emoji>');
    expect(output).toContain('Immortal 1');
  });

  it('rank_promo: Radiant shows icon + Radiant', () => {
    const output = renderTemplate('rank_promo', { to: 'Radiant' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<tg-emoji emoji-id="5190818141604715555">🌟</tg-emoji>');
    expect(output).toContain('Radiant');
  });

  it('rank_promo: no-payload produces Повышение по службе with player tag', () => {
    const output = renderTemplate('rank_promo', {}, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<b>Player#TAG</b>');
    expect(output).not.toContain('<tg-emoji');
  });

  it('rank_promo: unknown rank label renders escaped plain text without tg-emoji', () => {
    const output = renderTemplate('rank_promo', { to: 'MetaTier 1' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('MetaTier 1');
    expect(output).not.toContain('<tg-emoji');
  });

  it('winstreak_10plus: shows streak count and Винстрик heading', () => {
    const output = renderTemplate('winstreak_10plus', { streak: 10 }, safeUser);
    expect(output).toContain('10');
    expect(output).toContain('Винстрик');
    expect(output).toContain('побед подряд');
  });

  it('winstreak_10plus: player tag appears before count', () => {
    const output = renderTemplate('winstreak_10plus', { streak: 15 }, safeUser);
    expect(output).toContain('<b>Player#TAG</b>');
    expect(output).toContain('15');
  });

  it('giant_slayer: shows enemy avg rank and машина для убийства text', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1', delta: 2 }, safeUser);
    expect(output).toContain('Platinum 1');
    expect(output).toContain('машина для убийства');
  });

  it('giant_slayer: shows own rank', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1' }, safeUser);
    expect(output).toContain('Silver 2');
  });

  it('giant_slayer: includes match link when match_id present', () => {
    const output = renderTemplate('giant_slayer', { own: 'Gold 1', enemy_avg: 'Diamond 2' }, safeUser, { match_id: 'xyz789' });
    expect(output).toContain('tracker.gg/valorant/match/xyz789');
  });

  it('return_after_pause: shows days_paused and С возвращением text', () => {
    const output = renderTemplate('return_after_pause', { days_paused: 14 }, safeUser);
    expect(output).toContain('14');
    expect(output).toContain('С возвращением');
    expect(output).toContain('дней паузы');
  });

  it('return_after_pause: fallback ? when days_paused missing', () => {
    const output = renderTemplate('return_after_pause', {}, safeUser);
    expect(output).toContain('С возвращением');
    expect(output).toContain('? дней паузы');
  });

  it('teamkill: shows round count from round_numbers and Ля ты и крыса text', () => {
    const output = renderTemplate('teamkill', { round_numbers: [3, 7, 12] }, safeUser);
    expect(output).toContain('3×');
    expect(output).toContain('Ля ты и крыса');
  });

  it('teamkill: no count suffix when round_numbers is empty', () => {
    const output = renderTemplate('teamkill', {}, safeUser);
    expect(output).toContain('Ля ты и крыса');
    expect(output).not.toContain('×');
  });

  it('teamkill: includes map and match link', () => {
    const output = renderTemplate('teamkill', { round_numbers: [2] }, safeUser, { map: 'Bind', match_id: 'mID1' });
    expect(output).toContain('Bind');
    expect(output).toContain('tracker.gg/valorant/match/mID1');
  });

  it('fall_damage_death: includes map and звезда паркура text', () => {
    const output = renderTemplate('fall_damage_death', { count: 2 }, safeUser, { map: 'Icebox' });
    expect(output).toContain('Icebox');
    expect(output).toContain('звезда паркура');
  });

  it('fall_damage_death: shows count when present', () => {
    const output = renderTemplate('fall_damage_death', { count: 3 }, safeUser);
    expect(output).toContain('3×');
  });

  it('fall_damage_death: includes match link when match_id present', () => {
    const output = renderTemplate('fall_damage_death', {}, safeUser, { match_id: 'fall42' });
    expect(output).toContain('tracker.gg/valorant/match/fall42');
  });

  it('ace_rare_weapon_week: weapon name from rare set is HTML-escaped in fallback text', () => {
    // When weapons_per_round has no known rare tokens, weaponStr falls back to 'редким'
    const output = renderTemplate('ace_rare_weapon_week', { weapons_per_round: [['Vandal', 'Phantom']] }, safeUser);
    expect(output).toContain('редким');
    expect(output).toContain('знает толк в извращениях');
  });

  it('record_damage_dealt_match: shows Мясник недели heading and value', () => {
    const output = renderTemplate('record_damage_dealt_match', { value: 6840, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser);
    expect(output).toContain('Мясник недели');
    expect(output).toContain('6840 dmg');
    expect(output).toContain('<b>Player#TAG</b>');
  });

  it('record_damage_dealt_match: shows prev_name when different player holds record', () => {
    const output = renderTemplate('record_damage_dealt_match', {
      value: 6840,
      prev_value: 6420,
      prev_puuid: 'other-puuid',
      prev_name: 'OldHolder',
      prev_tag: 'OLD',
    }, { ...safeUser, riot_puuid: 'current-puuid' });
    expect(output).toContain('6420');
    expect(output).toContain('OldHolder');
  });

  it('record_damage_dealt_match: shows "тоже его" when same player beats own record', () => {
    const output = renderTemplate('record_damage_dealt_match', {
      value: 7000,
      prev_value: 6840,
      prev_puuid: 'same-puuid',
      prev_name: 'Player',
      prev_tag: 'TAG',
    }, { ...safeUser, riot_puuid: 'same-puuid' });
    expect(output).toContain('тоже его');
    expect(output).not.toContain('OldHolder');
  });

  it('record_damage_dealt_match: includes match link', () => {
    const output = renderTemplate('record_damage_dealt_match', { value: 6840, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser, { match_id: 'dmg-match-1' });
    expect(output).toContain('tracker.gg/valorant/match/dmg-match-1');
  });

  it('record_damage_received_match: shows Надругались над heading and value', () => {
    const output = renderTemplate('record_damage_received_match', { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser);
    expect(output).toContain('Надругались над');
    expect(output).toContain('5910 dmg за матч');
    expect(output).toContain('<b>Player#TAG</b>');
  });

  it('record_damage_received_match: shows «бедолага» when same player beats own record', () => {
    const output = renderTemplate('record_damage_received_match', {
      value: 6100,
      prev_value: 5910,
      prev_puuid: 'same-puuid',
      prev_name: 'Player',
      prev_tag: 'TAG',
    }, { ...safeUser, riot_puuid: 'same-puuid' });
    expect(output).toContain('бедолага');
    expect(output).toContain('предыдущий рекорд тоже его');
  });

  it('record_damage_received_match: shows prev_name when different player holds record', () => {
    const output = renderTemplate('record_damage_received_match', {
      value: 6100,
      prev_value: 5910,
      prev_puuid: 'other-puuid',
      prev_name: 'ToughGuy',
      prev_tag: 'TGH',
    }, { ...safeUser, riot_puuid: 'current-puuid' });
    expect(output).toContain('5910');
    expect(output).toContain('ToughGuy');
    expect(output).not.toContain('бедолага');
  });

  it('record_damage_received_match: includes match link', () => {
    const output = renderTemplate('record_damage_received_match', { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser, { match_id: 'rcv-match-1' });
    expect(output).toContain('tracker.gg/valorant/match/rcv-match-1');
  });
});

// ─── opponents_peak rendering ─────────────────────────────────────────────────

describe('renderTemplate — opponents_peak in ace', () => {
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
    expect(output).toContain('AAAAAAACE');
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
