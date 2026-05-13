import { describe, it, expect } from 'vitest';
import { renderTemplate, renderDigestGroup, esc } from './templates.ts';
import type { EventType } from './types.ts';

const ALL_EVENT_TYPES: EventType[] = [
  'ace',
  'ace_rare_weapon_week',
  'peak_rank_up',
  'winstreak_10plus',
  'giant_slayer',
  'return_after_pause',
  'teamkill',
  'fall_damage_death',
  'record_kills_match',
  'record_damage_dealt_match',
  'record_damage_received_match',
  'record_deaths_match',
  'record_headshots_match',
  'record_legshots_match',
  'knife_kill',
  'match_comeback',
  'record_mvp_count_week',
  'community_clash',
  'record_kills_per_weapon',
  'record_longest_match_minutes',
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
  peak_rank_up: {},
  winstreak_10plus: {},
  giant_slayer: {},
  return_after_pause: {},
  teamkill: {},
  fall_damage_death: {},
  record_kills_match: { value: 30, prev_value: null, prev_puuid: null },
  record_damage_dealt_match: { value: 6840, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
  record_damage_received_match: { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
  record_deaths_match: { value: 15, prev_value: null, prev_puuid: null },
  record_headshots_match: { value: 20, prev_value: null, prev_puuid: null },
  record_legshots_match: { value: 10, prev_value: null, prev_puuid: null },
  knife_kill: {},
  match_comeback: {},
  record_mvp_count_week: { value: 5, prev_value: null, prev_puuid: null },
  community_clash: { teams: [], winner_team_id: null },
  record_kills_per_weapon: { weapon: 'Operator', value: 5, prev_value: 3, prev_puuid: 'other-puuid', prev_name: 'OldHolder', prev_tag: 'OLD', real_match_id: 'match-xyz' },
  record_longest_match_minutes: { value: 45, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '', community_players: [], rounds: 24, result: 'win' },
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
  it('ace: shows kill count when round had 6+ kills', () => {
    const output = renderTemplate('ace', { weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']] }, safeUser);
    expect(output).toContain('6 убийств');
  });

  it('ace: no kill count when round had exactly 5 kills', () => {
    const output = renderTemplate('ace', { weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']] }, safeUser);
    expect(output).not.toContain('убийств');
  });

  it('ace: includes map from match param', () => {
    const output = renderTemplate('ace', {}, safeUser, { map: 'Ascent' });
    expect(output).toContain('на карте Ascent');
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
    expect(output.toLowerCase()).toContain('знает толк в извращениях');
  });

  it('rank_promo: Ascendant 1 shows "Повышение по службе" heading + icon + full rank label', () => {
    const output = renderTemplate('peak_rank_up', { from_tier_name: 'Diamond 3', to_tier_name: 'Ascendant 1' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<b>Player#TAG</b>');
    expect(output).toContain('<tg-emoji emoji-id="5188550815484256589">🟩</tg-emoji>');
    expect(output).toContain('Ascendant 1');
    expect(output).not.toContain('Diamond 3');
  });

  it('rank_promo: Immortal 1 shows icon + full rank label', () => {
    const output = renderTemplate('peak_rank_up', { to_tier_name: 'Immortal 1' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<tg-emoji emoji-id="5188459714932943688">♦️</tg-emoji>');
    expect(output).toContain('Immortal 1');
  });

  it('rank_promo: Radiant shows icon + Radiant', () => {
    const output = renderTemplate('peak_rank_up', { to_tier_name: 'Radiant' }, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<tg-emoji emoji-id="5190818141604715555">🌟</tg-emoji>');
    expect(output).toContain('Radiant');
  });

  it('rank_promo: no-payload produces Повышение по службе with player tag', () => {
    const output = renderTemplate('peak_rank_up', {}, safeUser);
    expect(output).toContain('Повышение по службе');
    expect(output).toContain('<b>Player#TAG</b>');
    expect(output).not.toContain('<tg-emoji');
  });

  it('rank_promo: unknown rank label renders escaped plain text without tg-emoji', () => {
    const output = renderTemplate('peak_rank_up', { to_tier_name: 'MetaTier 1' }, safeUser);
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

  it('giant_slayer: shows enemy avg rank and Поводил по губам text', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1', delta: 2 }, safeUser);
    expect(output).toContain('Platinum 1');
    expect(output.toLowerCase()).toContain('поводил(ла) по губам');
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

  it('fall_damage_death: includes map and 1:0 в пользу гравитации text', () => {
    const output = renderTemplate('fall_damage_death', { count: 2 }, safeUser, { map: 'Icebox' });
    expect(output).toContain('Icebox');
    expect(output.toLowerCase()).toContain('1:0 в пользу гравитации');
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
    expect(output.toLowerCase()).toContain('знает толк в извращениях');
  });

  it('record_damage_dealt_match: shows Мясник heading and value', () => {
    const output = renderTemplate('record_damage_dealt_match', { value: 6840, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser);
    expect(output).toContain('Мясник');
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

  it('record_damage_received_match: shows Груша для битья heading and value', () => {
    const output = renderTemplate('record_damage_received_match', { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser);
    expect(output).toContain('Груша для битья');
    expect(output).toContain('5910 dmg');
    expect(output).toContain('<b>Player#TAG</b>');
  });

  it('record_damage_received_match: shows "тоже его" when same player beats own record', () => {
    const output = renderTemplate('record_damage_received_match', {
      value: 6100,
      prev_value: 5910,
      prev_puuid: 'same-puuid',
      prev_name: 'Player',
      prev_tag: 'TAG',
    }, { ...safeUser, riot_puuid: 'same-puuid' });
    expect(output).toContain('тоже его');
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
  });

  it('record_damage_received_match: includes match link', () => {
    const output = renderTemplate('record_damage_received_match', { value: 5910, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' }, safeUser, { match_id: 'rcv-match-1' });
    expect(output).toContain('tracker.gg/valorant/match/rcv-match-1');
  });

  it('record_longest_match_minutes: shows minutes, rounds, map, result emoji, player line', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 58,
      rounds: 30,
      result: 'win',
      prev_value: null,
      prev_puuid: null,
      prev_name: '',
      prev_tag: '',
      community_players: [
        { puuid: 'p1', name: 'Alice', tag: 'ALI' },
        { puuid: 'p2', name: 'Bob', tag: 'BOB' },
      ],
    }, safeUser, { map: 'Ascent' });
    expect(output).toContain('Дело принципа');
    expect(output).toContain('58 минут');
    expect(output).toContain('(30 раундов)');
    expect(output).toContain('на карте Ascent');
    expect(output).toContain('🏆'); // win
    // Player line: nick#tag, nick#tag — not bolded, not "проинвестировал"
    expect(output).toContain('Alice#ALI');
    expect(output).toContain('Bob#BOB');
  });

  it('record_longest_match_minutes: shows loss emoji 💀 on result=loss', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 58, rounds: 30, result: 'loss',
      prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '',
      community_players: [],
    }, safeUser, { map: 'Bind' });
    expect(output).toContain('💀');
    expect(output).not.toContain('🏆');
  });

  it('record_longest_match_minutes: shows draw emoji 🏳️ on result=draw', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 58, rounds: 30, result: 'draw',
      prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '',
      community_players: [],
    }, safeUser, { map: 'Haven' });
    expect(output).toContain('🏳️');
  });

  it('record_longest_match_minutes: shows prev_name when different player held record', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 60, rounds: 32, result: 'win',
      prev_value: 45,
      prev_puuid: 'other-puuid',
      prev_name: 'OldHolder',
      prev_tag: 'OLD',
      community_players: [],
    }, { ...safeUser, riot_puuid: 'current-puuid' });
    expect(output).toContain('45');
    expect(output).toContain('OldHolder');
  });

  it('record_longest_match_minutes: shows тоже его when same player beats own record', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 60, rounds: 32, result: 'win',
      prev_value: 45,
      prev_puuid: 'same-puuid',
      prev_name: 'Player',
      prev_tag: 'TAG',
      community_players: [],
    }, { ...safeUser, riot_puuid: 'same-puuid' });
    expect(output).toContain('тоже его');
  });

  it('record_longest_match_minutes: includes match link when match_id present', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 45, rounds: 25, result: 'win',
      prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '',
      community_players: [],
    }, safeUser, { match_id: 'test-match-id' });
    expect(output).toContain('tracker.gg/valorant/match/test-match-id');
  });

  it('record_longest_match_minutes: HTML-escapes community player names and tags', () => {
    const output = renderTemplate('record_longest_match_minutes', {
      value: 45, rounds: 25, result: 'win',
      prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '',
      community_players: [{ puuid: 'p1', name: '<script>xss</script>', tag: '<img>' }],
    }, safeUser);
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('&lt;img&gt;');
  });
});

describe('renderDigestGroup — record_kills_per_weapon combined section', () => {
  const playerA = { riot_name: 'Alice', riot_tag: 'AAA', telegram_id: 1 };
  const playerB = { riot_name: 'Bob',   riot_tag: 'BBB', telegram_id: 2 };
  const playerC = { riot_name: 'Cara',  riot_tag: 'CCC', telegram_id: 3 };

  it('renders header "Оружейная мастерская" and one line per weapon entry', () => {
    const output = renderDigestGroup('record_kills_per_weapon', [
      { payload: { weapon: 'Bulldog', value: 7 }, user: playerA },
      { payload: { weapon: 'Sheriff', value: 10 }, user: playerB },
      { payload: { weapon: 'Operator', value: 6 }, user: playerC },
    ]);
    expect(output).toContain('Оружейная мастерская');
    expect(output).toContain('лидеры по убийствам одним оружием');
    expect(output).toContain('Bulldog');
    expect(output).toContain('Sheriff');
    expect(output).toContain('Operator');
    expect(output).toContain('Alice#AAA');
    expect(output).toContain('Bob#BBB');
    expect(output).toContain('Cara#CCC');
    expect(output).toContain('7 фрагов');
    expect(output).toContain('10 фрагов');
    expect(output).toContain('6 фрагов');
  });

  it('sorts entries by frag count descending', () => {
    const output = renderDigestGroup('record_kills_per_weapon', [
      { payload: { weapon: 'Bulldog', value: 4 }, user: playerA },
      { payload: { weapon: 'Sheriff', value: 10 }, user: playerB },
      { payload: { weapon: 'Operator', value: 7 }, user: playerC },
    ]);
    const idxSheriff = output.indexOf('Sheriff');
    const idxOperator = output.indexOf('Operator');
    const idxBulldog = output.indexOf('Bulldog');
    expect(idxSheriff).toBeLessThan(idxOperator);
    expect(idxOperator).toBeLessThan(idxBulldog);
  });

  it('does NOT include match link or prev-record line', () => {
    const output = renderDigestGroup('record_kills_per_weapon', [
      {
        payload: {
          weapon: 'Bulldog',
          value: 7,
          real_match_id: 'some-match-id',
          prev_value: 5,
          prev_name: 'Old',
          prev_tag: 'OLD',
          prev_puuid: 'other-puuid',
        },
        user: playerA,
      },
    ]);
    expect(output).not.toContain('tracker.gg');
    expect(output).not.toContain('прошлый рекорд');
    expect(output).not.toContain('Old#OLD');
  });

  it('HTML-escapes weapon names and player nicks', () => {
    const output = renderDigestGroup('record_kills_per_weapon', [
      { payload: { weapon: '<img>', value: 1 }, user: { riot_name: '<script>', riot_tag: 'X', telegram_id: 1 } },
    ]);
    expect(output).not.toContain('<img>');
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;img&gt;');
    expect(output).toContain('&lt;script&gt;');
  });
});
