import { describe, it, expect } from 'vitest';
import { renderRichDailyDigest, type RichDailyRow } from './rich-render.ts';
import { renderPlayerName, matchLinkIcon } from '../publisher/player-render.ts';

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

  it('renders the Эйсы section as an <h3> + striped table with the right columns', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
    expect(html).toContain('<table striped><tr><th>Игрок</th><th>Раунд</th><th>Матч</th></tr>');
  });

  it('renders the Ножи section as an <h3> + striped table with the right columns', () => {
    const html = renderRichDailyDigest([knifeRow()]);
    expect(html).toContain('<h3>🔪 Ножи</h3>');
    expect(html).toContain('<table striped><tr><th>Игрок</th><th>Раунд</th><th>Матч</th></tr>');
  });

  it('renders one row per event occurrence with renderPlayerName, round emoji, and matchLinkIcon', () => {
    const row = aceRow();
    const html = renderRichDailyDigest([row]);
    const player = renderPlayerName({
      name: 'Ace',
      tag: 'ACE',
      isCommunity: true,
      rank: 'Diamond 3',
      agent: 'Jett',
    });
    const match = matchLinkIcon({ url: TRACKER('m1'), mapName: 'Ascent' });
    expect(html).toContain(`<tr><td>${player}</td><td>🏆 3</td><td>${match}</td></tr>`);
  });

  it('renders 💀 N for a lost round and 🏆 N for a won round', () => {
    const html = renderRichDailyDigest([
      aceRow({ round0: 0, won: true }),
      aceRow({ round0: 5, won: false }),
    ]);
    expect(html).toContain('<td>🏆 1</td>');
    expect(html).toContain('<td>💀 6</td>');
  });

  it('renders a bare round number (no emoji) when the outcome is unknown', () => {
    const html = renderRichDailyDigest([aceRow({ round0: 3, won: null })]);
    expect(html).toContain('<td>4</td>');
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
    expect(html).toContain(`<td>${player}</td>`);
    // No rank prefix present in the player's own cell.
    expect(player).not.toContain('💎');
  });

  it('groups rows of the same player adjacently, keeping input (chronological) order within a player', () => {
    // Two players interleaved on input; grouping must make each player's rows adjacent.
    const rows: RichDailyRow[] = [
      aceRow({ riotName: 'Alpha', riotTag: 'A', matchId: 'a1', round0: 0, detectedAt: 1 }),
      aceRow({ riotName: 'Beta', riotTag: 'B', matchId: 'b1', round0: 1, detectedAt: 2 }),
      aceRow({ riotName: 'Alpha', riotTag: 'A', matchId: 'a2', round0: 4, detectedAt: 3 }),
    ];
    const html = renderRichDailyDigest(rows);
    // Alpha's two rows must be adjacent (a1 immediately followed by a2), Beta after.
    const posA1 = html.indexOf('/match/a1');
    const posA2 = html.indexOf('/match/a2');
    const posB1 = html.indexOf('/match/b1');
    expect(posA1).toBeGreaterThanOrEqual(0);
    expect(posA2).toBeGreaterThan(posA1);
    // Beta's single row is NOT between Alpha's two rows.
    expect(posB1).toBeGreaterThan(posA2);
    // Within Alpha, chronological order preserved (round 1 before round 5).
    expect(html.indexOf('<td>🏆 1</td>')).toBeLessThan(html.indexOf('<td>🏆 5</td>'));
  });

  it('omits the Ножи section entirely when there are no knife events', () => {
    const html = renderRichDailyDigest([aceRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
    expect(html).not.toContain('<h3>🔪 Ножи</h3>');
    // Only one table.
    expect(html.match(/<table/g)?.length).toBe(1);
  });

  it('omits the Эйсы section entirely when there are no ace events', () => {
    const html = renderRichDailyDigest([knifeRow()]);
    expect(html).toContain('<h3>🔪 Ножи</h3>');
    expect(html).not.toContain('<h3>🎯 Эйсы</h3>');
    expect(html.match(/<table/g)?.length).toBe(1);
  });

  it('renders both sections when both event types are present', () => {
    const html = renderRichDailyDigest([aceRow(), knifeRow()]);
    expect(html).toContain('<h3>🎯 Эйсы</h3>');
    expect(html).toContain('<h3>🔪 Ножи</h3>');
    expect(html.match(/<table/g)?.length).toBe(2);
    // Эйсы section precedes Ножи section.
    expect(html.indexOf('🎯 Эйсы')).toBeLessThan(html.indexOf('🔪 Ножи'));
  });

  it('never emits a raw newline (rich HTML collapses \\n browser-style)', () => {
    const html = renderRichDailyDigest([aceRow(), knifeRow(), aceRow({ round0: 9, won: null })]);
    expect(html).not.toContain('\n');
  });
});
