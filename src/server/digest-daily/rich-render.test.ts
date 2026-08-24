import { describe, it, expect } from 'vitest';
import { renderRichDailyDigest, type RichDailyRow } from './rich-render.ts';
import { renderPlayerName, richMatchLink } from '../publisher/player-render.ts';

const TRACKER = (id: string) => `https://tracker.gg/valorant/match/${id}`;

function aceRow(overrides: Partial<RichDailyRow> = {}): RichDailyRow {
  return {
    eventType: 'ace',
    riotName: 'Ace',
    riotTag: 'ACE',
    agent: 'Jett',
    rank: 'Diamond 3',
    map: 'Ascent',
    matchId: 'm1',
    round0: 2, // → round 3
    won: true,
    detectedAt: 1_000,
    ...overrides,
  };
}

function knifeRow(overrides: Partial<RichDailyRow> = {}): RichDailyRow {
  return {
    eventType: 'knife_kill',
    riotName: 'Knifer',
    riotTag: 'KNF',
    agent: 'Reyna',
    rank: 'Gold 1',
    map: 'Bind',
    matchId: 'k1',
    round0: 12, // → round 13
    won: false,
    detectedAt: 2_000,
    ...overrides,
  };
}

describe('renderRichDailyDigest', () => {
  it('renders the header as an <h2>', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<h2>🍿 Эйсы и ножи за предыдущие 24 часа</h2>');
  });

  it('renders the legend inside a <details> with ONLY the two 💀/🏆 lines (no 🎯/🔪 lines)', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain(
      '<details><summary>ℹ️ Легенда</summary>' +
        '<blockquote>💀 - без победы в раунде<br>🏆 - с победой в раунде</blockquote>' +
        '</details>',
    );
    // The dropped legend lines must be gone.
    expect(html).not.toContain('- Ace');
    expect(html).not.toContain('Заколол баранчика');
    expect(html).not.toContain('Распотрошил гуся');
    expect(html).not.toContain('🔪🪿');
  });

  it('emits NO table markup at all — the layout is flat lines', () => {
    const html = renderRichDailyDigest([aceRow(), knifeRow()]);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('<tr>');
    expect(html).not.toContain('<td>');
    expect(html).not.toContain('<th>');
  });

  it('renders the Эйсы section as an <h3> followed by flat lines', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
  });

  it('renders the Ножи section as an <h3> followed by flat lines', () => {
    const html = renderRichDailyDigest([knifeRow()]);
    expect(html).toContain('<h3>🔪 Ножи</h3>');
  });

  it('renders one line per player+match as `ник · раунд N · ссылка`', () => {
    const html = renderRichDailyDigest([aceRow()]);
    const player = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: 'Diamond 3',
      agent: 'Jett',
    });
    const match = richMatchLink({ url: TRACKER('m1'), mapName: 'Ascent' });
    expect(html).toContain(`${player} · раунд 🏆 3 · ${match}`);
  });

  it('links the map name itself (tg-emoji stays OUTSIDE the anchor in rich messages)', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<a href="https://tracker.gg/valorant/match/m1">Ascent</a>');
    // The map icon must not sit inside the anchor — that kills the link in rich.
    expect(html).not.toMatch(/<a href="[^"]*"><tg-emoji/);
  });

  it('collapses several rounds of the same player+match onto ONE line, ascending', () => {
    const html = renderRichDailyDigest([
      aceRow({ round0: 6, won: false }),
      aceRow({ round0: 2, won: true }),
      aceRow({ round0: 10, won: true }),
    ]);
    expect(html).toContain('· раунды 🏆 3, 💀 7, 🏆 11 ·');
    // The nick is printed once, not once per round.
    expect(html.match(/Ace#ACE/g)?.length).toBe(1);
  });

  it('renders 💀 N for a lost round and 🏆 N for a won round', () => {
    const html = renderRichDailyDigest([
      aceRow({ matchId: 'w1', round0: 0, won: true }),
      aceRow({ matchId: 'l1', round0: 5, won: false }),
    ]);
    expect(html).toContain('раунд 🏆 1');
    expect(html).toContain('раунд 💀 6');
  });

  it('renders a bare round number (no emoji) when the outcome is unknown', () => {
    const html = renderRichDailyDigest([aceRow({ round0: 3, won: null })]);
    expect(html).toContain('· раунд 4 ·');
    expect(html).not.toContain('🏆 4');
    expect(html).not.toContain('💀 4');
  });

  it('drops the rank icon when rank is null but keeps the agent icon (renderPlayerName contract)', () => {
    const html = renderRichDailyDigest([aceRow({ rank: null })]);
    const player = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: null,
      agent: 'Jett',
    });
    expect(html).toContain(player);
    // No rank prefix present in the player's own fragment.
    expect(player).not.toContain('💎');
  });

  it('groups lines of the same player adjacently, keeping input (chronological) order within a player', () => {
    // Two players interleaved on input; grouping must make each player's lines adjacent.
    const rows: RichDailyRow[] = [
      aceRow({ riotName: 'Alpha', riotTag: 'A', matchId: 'a1', round0: 0, detectedAt: 1 }),
      aceRow({ riotName: 'Beta', riotTag: 'B', matchId: 'b1', round0: 1, detectedAt: 2 }),
      aceRow({ riotName: 'Alpha', riotTag: 'A', matchId: 'a2', round0: 4, detectedAt: 3 }),
    ];
    const html = renderRichDailyDigest(rows);
    const posA1 = html.indexOf('/match/a1');
    const posA2 = html.indexOf('/match/a2');
    const posB1 = html.indexOf('/match/b1');
    expect(posA1).toBeGreaterThanOrEqual(0);
    expect(posA2).toBeGreaterThan(posA1);
    // Beta's single line is NOT between Alpha's two lines.
    expect(posB1).toBeGreaterThan(posA2);
    // Within Alpha, chronological order preserved (round 1 before round 5).
    expect(html.indexOf('раунд 🏆 1')).toBeLessThan(html.indexOf('раунд 🏆 5'));
  });

  it('separates lines with <br> (never a raw newline)', () => {
    const html = renderRichDailyDigest([
      aceRow({ riotName: 'Alpha', riotTag: 'A', matchId: 'a1' }),
      aceRow({ riotName: 'Beta', riotTag: 'B', matchId: 'b1' }),
    ]);
    expect(html).toContain('</a><br>');
  });

  it('omits the Ножи section entirely when there are no knife events', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
    expect(html).not.toContain('<h3>🔪 Ножи</h3>');
  });

  it('omits the Эйсы section entirely when there are no ace events', () => {
    const html = renderRichDailyDigest([knifeRow()]);
    expect(html).toContain('<h3>🔪 Ножи</h3>');
    expect(html).not.toContain('<h3>🎯 Эйсы</h3>');
  });

  it('renders both sections when both event types are present', () => {
    const html = renderRichDailyDigest([aceRow(), knifeRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
    expect(html).toContain('<h3>🔪 Ножи</h3>');
    // Эйсы section precedes Ножи section.
    expect(html.indexOf('🎯 Эйсы')).toBeLessThan(html.indexOf('🔪 Ножи'));
  });

  it('keeps ace and knife rounds of the same player+match on separate section lines', () => {
    const html = renderRichDailyDigest([
      aceRow({ riotName: 'Both', riotTag: 'B', matchId: 'same', round0: 1, won: true }),
      knifeRow({ riotName: 'Both', riotTag: 'B', matchId: 'same', round0: 8, won: false }),
    ]);
    expect(html).toContain('· раунд 🏆 2 ·');
    expect(html).toContain('· раунд 💀 9 ·');
  });

  it('never emits a raw newline (rich HTML collapses \\n browser-style)', () => {
    const html = renderRichDailyDigest([aceRow(), knifeRow(), aceRow({ round0: 9, won: null })]);
    expect(html).not.toContain('\n');
  });
});
