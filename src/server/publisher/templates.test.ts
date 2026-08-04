import { describe, it, expect } from 'vitest';
import { renderTemplate, esc } from './templates.ts';
import { isRealtimeEvent } from './types.ts';
import { mapToEmojiHtml, agentToEmojiHtml } from './valorant-emoji.ts';
import { rankToEmojiHtml } from './rank-emoji.ts';
import type { EventType } from './types.ts';

const ALL_EVENT_TYPES: EventType[] = [
  'ace',
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
  'record_survived_last_rounds',
  'record_died_first_rounds',
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
  record_survived_last_rounds: { value: 4, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
  record_died_first_rounds: { value: 4, prev_value: null, prev_puuid: null, prev_name: '', prev_tag: '' },
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

describe('renderTemplate — only realtime types have a template', () => {
  const FALLBACK = 'Новое событие у';

  it('every realtime event type renders a real template, not the fallback', () => {
    for (const t of ALL_EVENT_TYPES.filter((e) => isRealtimeEvent(e))) {
      const out = renderTemplate(t, minimalPayloads[t]!, safeUser);
      expect(out, `realtime type ${t} must have its own template`).not.toContain(FALLBACK);
    }
  });

  it('weekly types fall back — the digest renders them from its own model', () => {
    // ace / knife_kill / records / winstreaks / rank-ups are rendered by
    // digest/rich-render.ts, so their chat templates were deleted rather than
    // left to duplicate that copy.
    for (const t of ['ace', 'knife_kill', 'record_kills_match', 'winstreak_10plus', 'peak_rank_up'] as EventType[]) {
      expect(renderTemplate(t, {}, safeUser), `${t} should fall back`).toContain(FALLBACK);
    }
  });

  it('the two unrendered records still keep their wording (nothing shows them yet)', () => {
    // record_survived_last_rounds / record_died_first_rounds (🐴 Троянский конь,
    // #281) are weekly but are ALSO missing from the digest's
    // BRIGHT_EVENT_WEIGHTS / RICH_RECORD_META, so these templates are the only
    // surviving copy of their text. Guard them until the digest wires them up.
    expect(renderTemplate('record_died_first_rounds', { value: 4 }, safeUser)).toContain('Троянский конь');
    expect(renderTemplate('record_survived_last_rounds', { value: 4 }, safeUser)).not.toContain(FALLBACK);
  });
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

  it('ace: no kill count when round had exactly 5 kills', () => {
    const output = renderTemplate('ace', { weapons_per_round: [['Vandal', 'Vandal', 'Vandal', 'Vandal', 'Vandal']] }, safeUser);
    expect(output).not.toContain('убийств');
  });

  it('giant_slayer: shows enemy avg rank as emoji (no text) and Поводил по губам text', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1', delta: 2 }, safeUser);
    // #301: ranks → emoji only. Platinum 1 → 🐳 icon, Silver 2 → 🥈 icon.
    expect(output).toContain('<tg-emoji emoji-id="5264763678711913942">🐳</tg-emoji>');
    expect(output).not.toContain('Platinum 1');
    expect(output.toLowerCase()).toContain('поводил(ла) по губам');
  });

  it('giant_slayer: shows own rank as emoji (no text)', () => {
    const output = renderTemplate('giant_slayer', { own: 'Silver 2', enemy_avg: 'Platinum 1' }, safeUser);
    expect(output).toContain('<tg-emoji emoji-id="5265139299371755545">🥈</tg-emoji>');
    expect(output).not.toContain('Silver 2');
  });

  it('giant_slayer: includes match link when match_id present', () => {
    const output = renderTemplate('giant_slayer', { own: 'Gold 1', enemy_avg: 'Diamond 2' }, safeUser, { match_id: 'xyz789' });
    expect(output).toContain('tracker.gg/valorant/match/xyz789');
  });

  it('match_comeback: header is plain (no underline)', () => {
    const output = renderTemplate('match_comeback', {}, safeUser);
    expect(output).toContain('👏 Мы вами гордимся');
    expect(output).not.toContain('<u>');
    expect(output).not.toContain('</u>');
  });

  it('match_comeback: minimal payload falls back to single user with medal prefix', () => {
    const output = renderTemplate(
      'match_comeback',
      { deficit_score_player: 0, deficit_score_opponent: 9, final_score_player: 16, final_score_opponent: 14 },
      safeUser,
      { map: 'Breeze', match_id: 'abc' },
    );
    expect(output).toContain('🏅<b>Player#TAG</b>');
    expect(output).toContain('<i>отыгрались</i> с <b>0:9</b> до <b>16:14</b>');
    expect(output).toContain(`${mapToEmojiHtml('Breeze')} <a href="https://tracker.gg/valorant/match/abc">Breeze</a>`);
    // No legacy "матч" link when map is present.
    expect(output).not.toContain('>матч<');
  });

  it('match_comeback: multiple community_players renders one per line with medal prefix and map-link', () => {
    const output = renderTemplate(
      'match_comeback',
      {
        deficit_score_player: 0,
        deficit_score_opponent: 9,
        final_score_player: 16,
        final_score_opponent: 14,
        community_players: [
          { puuid: 'p1', name: 'Alpha', tag: 'A' },
          { puuid: 'p2', name: 'Bravo', tag: 'B' },
          { puuid: 'p3', name: 'Charlie', tag: 'C' },
        ],
      },
      safeUser,
      { map: 'Breeze', match_id: 'm-1' },
    );
    expect(output).toContain('🏅<b>Alpha#A</b>\n🏅<b>Bravo#B</b>\n🏅<b>Charlie#C</b>');
    expect(output).toContain('<i>отыгрались</i> с <b>0:9</b> до <b>16:14</b>');
    expect(output).toContain(`${mapToEmojiHtml('Breeze')} <a href="https://tracker.gg/valorant/match/m-1">Breeze</a>`);
    // The triggering safeUser must not leak when community_players is set.
    expect(output).not.toContain('<b>Player#TAG</b>');
  });

  it('match_comeback: falls back to "матч" link when map is missing but match_id present', () => {
    const output = renderTemplate(
      'match_comeback',
      { deficit_score_player: 0, deficit_score_opponent: 9, final_score_player: 13, final_score_opponent: 11 },
      safeUser,
      { match_id: 'no-map' },
    );
    expect(output).toContain('<a href="https://tracker.gg/valorant/match/no-map">матч</a>');
    expect(output).not.toContain('🗺️');
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

  it('return_after_pause: minimal format — <b> header, no blank line, no <u>', () => {
    const output = renderTemplate('return_after_pause', { days_paused: 14 }, safeUser);
    expect(output).toBe('👋 <b>С возвращением</b>\n<b>Player#TAG</b> — после 14 дней паузы снова в строю');
    expect(output).not.toContain('<u>');
    expect(output).not.toContain('\n\n');
  });

  it('return_after_pause: match link with map-emoji on its OWN line (#315)', () => {
    const output = renderTemplate('return_after_pause', { days_paused: 20 }, safeUser, { match_id: 'ret1', map: 'Ascent' });
    expect(output).toContain(`\n<a href="https://tracker.gg/valorant/match/ret1">${mapToEmojiHtml('Ascent')} Ascent</a>`);
    expect(output).not.toContain('· <a href=');
  });

  it('return_after_pause: no match link when match_id absent', () => {
    const output = renderTemplate('return_after_pause', { days_paused: 20 }, safeUser);
    expect(output).not.toContain('tracker.gg');
    expect(output).not.toContain('·');
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

  it('teamkill: minimal format — <b> header, no blank line, no <u>', () => {
    const output = renderTemplate('teamkill', {}, safeUser);
    expect(output).toContain('🐀 <b>Ля ты и крыса</b>\n');
    expect(output).not.toContain('<u>');
    expect(output).not.toContain('\n\n');
  });

  it('teamkill: match link with map-emoji label on its OWN line (#315)', () => {
    const output = renderTemplate('teamkill', { round_numbers: [2] }, safeUser, { map: 'Bind', match_id: 'mID1' });
    expect(output).toContain(`\n<a href="https://tracker.gg/valorant/match/mID1">${mapToEmojiHtml('Bind')} Bind</a>`);
    expect(output).not.toContain('· <a href=');
  });

  it('fall_damage_death: includes map and 1:0 в пользу гравитации text', () => {
    const output = renderTemplate('fall_damage_death', { count: 2 }, safeUser, { map: 'Icebox', match_id: 'fall9' });
    expect(output).toContain('Icebox'); // map now lives in the link label
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

  it('fall_damage_death: minimal format — <b> header, no blank line, no <u>', () => {
    const output = renderTemplate('fall_damage_death', {}, safeUser);
    expect(output).toBe('🪂 <b>1:0 в пользу гравитации</b>\n<b>Player#TAG</b> — умер(ла) от падения');
    expect(output).not.toContain('<u>');
    expect(output).not.toContain('\n\n');
  });

  it('fall_damage_death: match link with map-emoji label on its OWN line (#315)', () => {
    const output = renderTemplate('fall_damage_death', { count: 2 }, safeUser, { map: 'Icebox', match_id: 'fall1' });
    expect(output).toContain(`\n<a href="https://tracker.gg/valorant/match/fall1">${mapToEmojiHtml('Icebox')} Icebox</a>`);
    expect(output).not.toContain('· <a href=');
  });

});

describe('renderTemplate — agent emoji next to nicks (#301)', () => {
  // Jett → AGENT_EMOJI['jett'] = 5265124043647916479.
  const JETT = '<tg-emoji emoji-id="5265124043647916479">';
  const SAGE = '<tg-emoji emoji-id="5267462919628560472">';

  it('teamkill: killer + community victim each show their agent emoji', () => {
    const output = renderTemplate(
      'teamkill',
      { round_numbers: [3], victims: [{ name: 'Friendly', tag: 'GG', agent: 'Sage' }] },
      safeUser,
      { agent: 'Jett' },
    );
    expect(output).toContain('<b>Player#TAG</b> ' + JETT); // killer
    expect(output).toContain('<b>Friendly#GG</b> ' + SAGE); // victim — full Ник#Тег (#315)
  });

  it('fall_damage_death: shows agent emoji next to nick from match.agent', () => {
    const output = renderTemplate('fall_damage_death', {}, safeUser, { agent: 'Jett' });
    expect(output).toContain('<b>Player#TAG</b> ' + JETT);
  });

  it('return_after_pause: shows agent emoji next to nick from match.agent', () => {
    const output = renderTemplate('return_after_pause', { days_paused: 14 }, safeUser, { agent: 'Jett' });
    expect(output).toContain('<b>Player#TAG</b> ' + JETT);
  });

  it('community_clash: each player shows their agent emoji from payload', () => {
    const output = renderTemplate(
      'community_clash',
      {
        teams: [
          { team_id: 'Blue', players: [{ puuid: 'a', name: 'Alice', tag: 'A', agent: 'Jett' }] },
          { team_id: 'Red', players: [{ puuid: 'b', name: 'Bob', tag: 'B', agent: 'Sage' }] },
        ],
        winner_team_id: 'Blue',
      },
      safeUser,
    );
    expect(output).toContain('<b>Alice</b> ' + JETT);
    expect(output).toContain('<b>Bob</b> ' + SAGE);
  });

  it('match_comeback: each community player shows their agent emoji from payload', () => {
    const output = renderTemplate(
      'match_comeback',
      {
        deficit_score_player: 3, deficit_score_opponent: 11,
        final_score_player: 13, final_score_opponent: 11,
        community_players: [{ puuid: 'a', name: 'Alice', tag: 'A', agent: 'Jett' }],
      },
      safeUser,
    );
    expect(output).toContain('🏅<b>Alice#A</b> ' + JETT);
  });
});

describe('renderTemplate — #315 minimal trio: renderPlayerName + match link on its own line', () => {
  const JETT = agentToEmojiHtml('Jett');
  const SAGE = agentToEmojiHtml('Sage');
  const D3 = rankToEmojiHtml('Diamond 3');
  const G1 = rankToEmojiHtml('Gold 1');

  it('teamkill: full three-line structure — header / body / match link', () => {
    const output = renderTemplate(
      'teamkill',
      { round_numbers: [3, 7] },
      safeUser,
      {
        match_id: 'm1',
        map: 'Ascent',
        rank: 'Diamond 3',
        agent: 'Jett',
        victims: [{ name: 'Danya', tag: 'UA1', agent: 'Sage', rank: 'Gold 1' }],
      },
    );
    expect(output).toBe(
      '🐀 <b>Ля ты и крыса</b>\n' +
      `${D3} <b>Player#TAG</b> ${JETT} убил(а) своего (${G1} <b>Danya#UA1</b> ${SAGE}) (2× за матч)\n` +
      `<a href="https://tracker.gg/valorant/match/m1">${mapToEmojiHtml('Ascent')} Ascent</a>`,
    );
  });

  it('teamkill: killer rank emoji present with match.rank, absent without', () => {
    const withRank = renderTemplate('teamkill', {}, safeUser, { rank: 'Diamond 3' });
    expect(withRank).toContain(`${D3} <b>Player#TAG</b>`);
    const withoutRank = renderTemplate('teamkill', {}, safeUser, {});
    expect(withoutRank).not.toContain('<tg-emoji');
  });

  it('teamkill: loop-resolved match.victims take precedence over raw payload victims', () => {
    const output = renderTemplate(
      'teamkill',
      { victims: [{ name: 'PayloadOnly', tag: 'X', agent: 'Sage' }] },
      safeUser,
      { match_id: 'm1', victims: [{ name: 'Resolved', tag: 'Y', rank: 'Gold 1' }] },
    );
    expect(output).toContain(`(${G1} <b>Resolved#Y</b>)`);
    expect(output).not.toContain('PayloadOnly');
  });

  it('teamkill: victim without resolvable rank → bold Ник#Тег, no rank emoji', () => {
    const output = renderTemplate(
      'teamkill',
      { victims: [{ name: 'Danya', tag: 'UA1' }] },
      safeUser,
    );
    expect(output).toContain('(<b>Danya#UA1</b>)');
    expect(output).not.toContain('<tg-emoji');
  });

  it('teamkill: legacy names-only payload → bold name without a dangling #', () => {
    const output = renderTemplate('teamkill', { victim_names_for_template: ['OldGuy'] }, safeUser);
    expect(output).toContain('(<b>OldGuy</b>)');
    expect(output).not.toContain('OldGuy#');
  });

  it('fall_damage_death: three-line structure with rank + agent', () => {
    const output = renderTemplate(
      'fall_damage_death',
      { count: 2 },
      safeUser,
      { match_id: 'f1', map: 'Icebox', rank: 'Diamond 3', agent: 'Jett' },
    );
    expect(output).toBe(
      '🪂 <b>1:0 в пользу гравитации</b>\n' +
      `${D3} <b>Player#TAG</b> ${JETT} — умер(ла) от падения (2×)\n` +
      `<a href="https://tracker.gg/valorant/match/f1">${mapToEmojiHtml('Icebox')} Icebox</a>`,
    );
  });

  it('return_after_pause: three-line structure with rank + agent', () => {
    const output = renderTemplate(
      'return_after_pause',
      { days_paused: 14 },
      safeUser,
      { match_id: 'r1', map: 'Bind', rank: 'Gold 1', agent: 'Sage' },
    );
    expect(output).toBe(
      '👋 <b>С возвращением</b>\n' +
      `${G1} <b>Player#TAG</b> ${SAGE} — после 14 дней паузы снова в строю\n` +
      `<a href="https://tracker.gg/valorant/match/r1">${mapToEmojiHtml('Bind')} Bind</a>`,
    );
  });

  it('fall_damage_death / return_after_pause: no rank emoji when rank not resolvable', () => {
    const fall = renderTemplate('fall_damage_death', {}, safeUser, { match_id: 'f2' });
    expect(fall).not.toContain('<tg-emoji');
    const ret = renderTemplate('return_after_pause', { days_paused: 3 }, safeUser, { match_id: 'r2' });
    expect(ret).not.toContain('<tg-emoji');
  });
});
