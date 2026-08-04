import { describe, it, expect } from 'vitest';
import { renderRichTemplate, isTrioRichEvent, type RichTemplateContext } from './rich-templates.ts';
import { mapToEmojiHtml } from './valorant-emoji.ts';
import type { FullRosterRow } from '../db/queries.ts';

/**
 * Pure renderer tests for the #315 "trio" full-roster rich templates. These do
 * NOT touch the DB (they pass a hand-built roster), so they run everywhere
 * (bun:sqlite / better-sqlite3 ABI issues don't apply). The DB assembly
 * (`renderRichEvent` → `getFullRoster`) is covered in queries.test.ts.
 */

/** Build a FullRosterRow with sane, complete defaults; override per case. */
function row(overrides: Partial<FullRosterRow> = {}): FullRosterRow {
  return {
    riot_puuid: 'p-' + Math.random().toString(36).slice(2, 8),
    team: 'Blue',
    name: 'Player',
    tag: 'EU',
    agent: 'Jett',
    tier: 'Diamond 2',
    kills: 20,
    deaths: 15,
    is_community: true,
    ...overrides,
  };
}

/** A complete 5v5 roster: 5 Blue (2 community), 5 Red (0 community). */
function fullRoster(): FullRosterRow[] {
  return [
    row({ riot_puuid: 'b1', team: 'Blue', name: 'Alice', tag: 'AAA', is_community: true, kills: 21, deaths: 14, agent: 'Jett' }),
    row({ riot_puuid: 'b2', team: 'Blue', name: 'Bob', tag: 'BBB', is_community: true, kills: 18, deaths: 12, agent: 'Sova' }),
    row({ riot_puuid: 'b3', team: 'Blue', name: 'Carol', tag: 'CCC', is_community: false, kills: 10, deaths: 16, agent: 'Omen' }),
    row({ riot_puuid: 'b4', team: 'Blue', name: 'Dan', tag: 'DDD', is_community: false, kills: 12, deaths: 13 }),
    row({ riot_puuid: 'b5', team: 'Blue', name: 'Eve', tag: 'EEE', is_community: false, kills: 9, deaths: 14 }),
    row({ riot_puuid: 'r1', team: 'Red', name: 'Frank', tag: 'FFF', is_community: false, kills: 16, deaths: 18 }),
    row({ riot_puuid: 'r2', team: 'Red', name: 'Gina', tag: 'GGG', is_community: false, kills: 13, deaths: 15 }),
    row({ riot_puuid: 'r3', team: 'Red', name: 'Hank', tag: 'HHH', is_community: false, kills: 11, deaths: 16 }),
    row({ riot_puuid: 'r4', team: 'Red', name: 'Ivy', tag: 'III', is_community: false, kills: 9, deaths: 19 }),
    row({ riot_puuid: 'r5', team: 'Red', name: 'Jack', tag: 'JJJ', is_community: false, kills: 7, deaths: 20 }),
  ];
}

const MATCH_ID = 'match-xyz';
const MAP = 'Ascent';

function ctx(overrides: Partial<RichTemplateContext> = {}): RichTemplateContext {
  return { roster: fullRoster(), matchId: MATCH_ID, map: MAP, ...overrides };
}

describe('isTrioRichEvent', () => {
  it('is true only for the three trio events', () => {
    expect(isTrioRichEvent('giant_slayer')).toBe(true);
    expect(isTrioRichEvent('match_comeback')).toBe(true);
    expect(isTrioRichEvent('community_clash')).toBe(true);
    expect(isTrioRichEvent('teamkill')).toBe(false);
    expect(isTrioRichEvent('ace')).toBe(false);
    expect(isTrioRichEvent('return_after_pause')).toBe(false);
  });
});

describe('renderRichTemplate — table structure & content', () => {
  it('renders all 10 participants as rows', () => {
    const html = renderRichTemplate('giant_slayer', ctx());
    expect(html).not.toBeNull();
    // Count player <tr> rows: total rows minus header minus separators.
    const trCount = (html!.match(/<tr>/g) ?? []).length;
    // 10 players + 1 header + 1 mid-team separator (giant_slayer) = 12
    expect(trCount).toBe(12);
    // Every participant name appears.
    for (const name of ['Alice', 'Bob', 'Carol', 'Frank', 'Jack']) {
      expect(html).toContain(name);
    }
  });

  it('has a two-column header: Игрок | Агент · K/D', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    expect(html).toContain('<th>Игрок</th><th>Агент · K/D</th>');
  });

  it('renders K/D in the second column as kills/deaths', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    expect(html).toContain('21/14'); // Alice
    expect(html).toContain('7/20');  // Jack
  });

  it('bolds community players and leaves opponents plain', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    // Community (Alice) → bold nick#tag
    expect(html).toContain('<b>Alice#AAA</b>');
    expect(html).toContain('<b>Bob#BBB</b>');
    // Non-community (Frank, Carol) → plain nick#tag, never bold
    expect(html).toContain('Frank#FFF');
    expect(html).not.toContain('<b>Frank#FFF</b>');
    expect(html).toContain('Carol#CCC');
    expect(html).not.toContain('<b>Carol#CCC</b>');
  });

  it('puts the rank emoji on the LEFT of the name (renderPlayerName contract)', () => {
    // Diamond tier resolves to a custom emoji; ensure it precedes the nick.
    const html = renderRichTemplate('giant_slayer', ctx())!;
    // The tg-emoji for the rank appears before the bold community nick.
    const aliceIdx = html.indexOf('Alice#AAA');
    const emojiBeforeAlice = html.lastIndexOf('<tg-emoji', aliceIdx);
    expect(emojiBeforeAlice).toBeGreaterThanOrEqual(0);
    expect(emojiBeforeAlice).toBeLessThan(aliceIdx);
  });

  it('renders the title bold with the verbatim heading', () => {
    expect(renderRichTemplate('giant_slayer', ctx())!).toContain('💪 <b>Поводил(ла) по губам</b>');
    expect(renderRichTemplate('match_comeback', ctx())!).toContain('👏 <b>Мы вами гордимся</b>');
    expect(renderRichTemplate('community_clash', ctx())!).toContain('⚔️ <b>Френдлифаер</b>');
  });

  it('giant_slayer names its subject on a line under the title (heroPuuid)', () => {
    const html = renderRichTemplate('giant_slayer', ctx({ heroPuuid: 'b1' }))!;
    // The hero (Alice, community → bold) is named right after the title,
    // before the description line.
    const titleEnd = html.indexOf('</b>') + '</b>'.length;
    const heroIdx = html.indexOf('<b>Alice#AAA</b>');
    const descIdx = html.indexOf('<i>Выиграл');
    expect(heroIdx).toBeGreaterThan(titleEnd);
    expect(heroIdx).toBeLessThan(descIdx);
    // A <br> separates the title line from the hero line (rich dialect).
    expect(html).toContain('</b><br>');
  });

  it('giant_slayer without heroPuuid renders no hero line (graceful)', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    // No hero line: the title flows straight into the description line.
    expect(html).toContain('Поводил(ла) по губам</b><br><i>');
  });

  it('giant_slayer with an unknown heroPuuid renders no hero line', () => {
    const html = renderRichTemplate('giant_slayer', ctx({ heroPuuid: 'not-in-roster' }))!;
    expect(html).toContain('Поводил(ла) по губам</b><br><i>');
  });

  it('match_comeback / community_clash ignore heroPuuid (no single subject)', () => {
    const comeback = renderRichTemplate('match_comeback', ctx({ heroPuuid: 'b1' }))!;
    expect(comeback).toContain('Мы вами гордимся</b><br><i>');
    const clash = renderRichTemplate('community_clash', ctx({ heroPuuid: 'b1', winnerTeamId: 'Blue' }))!;
    expect(clash).toContain('Френдлифаер</b><br><i>');
  });

  it('renders the description as a plain italic line — no accordion', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    expect(html).toContain('<br><i>Выиграл(а) против превосходящего врага.</i>');
    // The «ℹ️ Что случилось» accordion is gone for every trio event.
    for (const t of ['giant_slayer', 'match_comeback', 'community_clash'] as const) {
      const out = renderRichTemplate(t, ctx({ winnerTeamId: 'Blue' }))!;
      expect(out, t).not.toContain('<details>');
      expect(out, t).not.toContain('Что случилось');
      expect(out, t).not.toContain('<blockquote>');
    }
  });

  it('renders the match link under the table with the icon OUTSIDE the anchor', () => {
    const html = renderRichTemplate('giant_slayer', ctx())!;
    // A Rich Message will not linkify an <a> that contains a <tg-emoji>, so the
    // map icon sits outside and only the name is the anchor.
    const expected =
      `<br>${mapToEmojiHtml(MAP)} <a href="https://tracker.gg/valorant/match/${MATCH_ID}">${MAP}</a>`;
    expect(html).toContain(expected);
    expect(html.endsWith(expected)).toBe(true);
    expect(html).not.toContain(`<a href="https://tracker.gg/valorant/match/${MATCH_ID}"><tg-emoji`);
  });
});

describe('renderRichTemplate — team grouping & separators', () => {
  it('giant_slayer / match_comeback use a NEUTRAL separator (no team names)', () => {
    for (const type of ['giant_slayer', 'match_comeback'] as const) {
      const html = renderRichTemplate(type, ctx())!;
      // Exactly one full-width separator between the two fives.
      const seps = (html.match(/<td colspan="2">/g) ?? []).length;
      expect(seps).toBe(1);
      // No "Команда" label for these.
      expect(html).not.toContain('Команда');
    }
  });

  it('community_clash labels both teams «Команда А/Б» via colspan separators', () => {
    const html = renderRichTemplate('community_clash', ctx({ winnerTeamId: 'Blue', teamScores: { Blue: { won: 13, lost: 11 }, Red: { won: 11, lost: 13 } } }))!;
    const seps = (html.match(/<td colspan="2">/g) ?? []).length;
    expect(seps).toBe(2); // one per team
    expect(html).toContain('Команда А');
    expect(html).toContain('Команда Б');
  });

  it('community_clash marks the winner with a medal + "победа X:Y" score', () => {
    const html = renderRichTemplate('community_clash', ctx({ winnerTeamId: 'Blue', teamScores: { Blue: { won: 13, lost: 11 }, Red: { won: 11, lost: 13 } } }))!;
    expect(html).toContain('🥇');
    expect(html).toContain('победа 13:11');
    // The losing team's separator carries no "победа".
    // Count occurrences of "победа" — exactly one (winner only).
    const wins = (html.match(/победа/g) ?? []).length;
    expect(wins).toBe(1);
  });

  it('community_clash without team scores still marks the winner (score omitted)', () => {
    const html = renderRichTemplate('community_clash', ctx({ winnerTeamId: 'Blue' }))!;
    expect(html).toContain('🥇');
    expect(html).toContain('победа');
    expect(html).not.toContain('победа 13'); // no numeric score
  });

  it('community_clash draw (winnerTeamId null) marks no winner', () => {
    const html = renderRichTemplate('community_clash', ctx({ winnerTeamId: null }))!;
    expect(html).not.toContain('🥇');
    expect(html).not.toContain('победа');
  });
});

describe('renderRichTemplate — backward-compat / null fallback', () => {
  it('returns null for a non-trio event type', () => {
    expect(renderRichTemplate('teamkill', ctx())).toBeNull();
    expect(renderRichTemplate('ace', ctx())).toBeNull();
  });

  it('returns null on an empty roster', () => {
    expect(renderRichTemplate('giant_slayer', ctx({ roster: [] }))).toBeNull();
  });

  it('returns null when ANY participant is missing tier (pre-#315 rows)', () => {
    const roster = fullRoster();
    roster[3]!.tier = null;
    expect(renderRichTemplate('giant_slayer', ctx({ roster }))).toBeNull();
  });

  it('returns null when ANY participant is missing kills or deaths', () => {
    const r1 = fullRoster(); r1[5]!.kills = null;
    expect(renderRichTemplate('giant_slayer', ctx({ roster: r1 }))).toBeNull();
    const r2 = fullRoster(); r2[6]!.deaths = null;
    expect(renderRichTemplate('giant_slayer', ctx({ roster: r2 }))).toBeNull();
  });

  it('returns null when only one team is present', () => {
    const roster = fullRoster().filter((r) => r.team === 'Blue');
    expect(renderRichTemplate('giant_slayer', ctx({ roster }))).toBeNull();
  });

  it('never emits a raw newline (rich HTML collapses \\n)', () => {
    const html = renderRichTemplate('community_clash', ctx({ winnerTeamId: 'Blue', teamScores: { Blue: { won: 13, lost: 11 }, Red: { won: 11, lost: 13 } } }))!;
    expect(html).not.toContain('\n');
  });
});

describe('renderRichTemplate — HTML escaping', () => {
  it('escapes hostile nick/tag in participant rows', () => {
    const roster = fullRoster();
    roster[2] = row({ riot_puuid: 'x', team: 'Blue', name: '<b>x</b>', tag: '"&', is_community: false, kills: 1, deaths: 1, agent: null });
    const html = renderRichTemplate('giant_slayer', ctx({ roster }))!;
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>#');
  });
});
