import { describe, it, expect } from 'vitest';
import { renderPlayerName, matchLink, matchLinkIcon } from './player-render.ts';
import { rankToEmojiHtml } from './rank-emoji.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from './valorant-emoji.ts';

describe('renderPlayerName', () => {
  it('renders community player bold, no rank/agent', () => {
    expect(renderPlayerName({ name: 'Player', tag: 'TAG', isCommunity: true })).toBe(
      '<b>Player#TAG</b>',
    );
  });

  it('renders non-community player plain, no rank/agent', () => {
    expect(renderPlayerName({ name: 'Player', tag: 'TAG', isCommunity: false })).toBe(
      'Player#TAG',
    );
  });

  it('HTML-escapes name and tag', () => {
    const output = renderPlayerName({
      name: '<script>alert(1)</script>',
      tag: '<img>',
      isCommunity: true,
    });
    expect(output).not.toContain('<script>');
    expect(output).toBe(
      '<b>&lt;script&gt;alert(1)&lt;/script&gt;#&lt;img&gt;</b>',
    );
  });

  it('escapes plain (non-community) output too', () => {
    const output = renderPlayerName({
      name: '<b>x</b>',
      tag: 'T',
      isCommunity: false,
    });
    expect(output).toBe('&lt;b&gt;x&lt;/b&gt;#T');
  });

  it('prefixes rank emoji on the left when rank is known', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      rank: 'Diamond 3',
    });
    expect(output).toBe(`${rankToEmojiHtml('Diamond 3')} <b>Player#TAG</b>`);
  });

  it('omits rank icon when rank is absent', () => {
    const output = renderPlayerName({ name: 'Player', tag: 'TAG', isCommunity: true });
    expect(output).not.toContain('tg-emoji');
  });

  it('omits rank icon when rank is unrecognised', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      rank: 'Bogus Rank',
    });
    expect(output).toBe('<b>Player#TAG</b>');
  });

  it('omits rank icon when rank is null', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      rank: null,
    });
    expect(output).toBe('<b>Player#TAG</b>');
  });

  it('appends agent emoji on the right when agent is known', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      agent: 'Jett',
    });
    expect(output).toBe(`<b>Player#TAG</b> ${agentToEmojiHtml('Jett')}`);
  });

  it('omits agent icon when agent is absent', () => {
    const output = renderPlayerName({ name: 'Player', tag: 'TAG', isCommunity: true });
    expect(output).toBe('<b>Player#TAG</b>');
  });

  it('omits agent icon when agent is unrecognised', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      agent: 'NotARealAgent',
    });
    expect(output).toBe('<b>Player#TAG</b>');
  });

  it('renders rank + agent together, rank left / agent right, bold name in the middle', () => {
    const output = renderPlayerName({
      name: 'Player',
      tag: 'TAG',
      isCommunity: true,
      rank: 'Radiant',
      agent: 'Sova',
    });
    expect(output).toBe(
      `${rankToEmojiHtml('Radiant')} <b>Player#TAG</b> ${agentToEmojiHtml('Sova')}`,
    );
  });

  it('renders rank + agent for a non-community (plain) player too', () => {
    const output = renderPlayerName({
      name: 'Enemy',
      tag: 'FOE',
      isCommunity: false,
      rank: 'Gold 2',
      agent: 'Cypher',
    });
    expect(output).toBe(
      `${rankToEmojiHtml('Gold 2')} Enemy#FOE ${agentToEmojiHtml('Cypher')}`,
    );
  });
});

describe('matchLink', () => {
  it('renders "[map-emoji] MapName" as the link when map is known', () => {
    const output = matchLink({ url: 'https://tracker.gg/valorant/match/abc123', mapName: 'Breeze' });
    expect(output).toBe(
      `<a href="https://tracker.gg/valorant/match/abc123">${mapToEmojiHtml('Breeze')} Breeze</a>`,
    );
  });

  it('renders name-only link when map is not in the emoji pack', () => {
    const output = matchLink({ url: 'https://tracker.gg/valorant/match/abc123', mapName: 'Bogus Map' });
    expect(output).toBe('<a href="https://tracker.gg/valorant/match/abc123">Bogus Map</a>');
  });

  it('falls back to just "матч" when map is absent', () => {
    const output = matchLink({ url: 'https://tracker.gg/valorant/match/abc123' });
    expect(output).toBe('<a href="https://tracker.gg/valorant/match/abc123">матч</a>');
  });

  it('HTML-escapes the url', () => {
    const output = matchLink({ url: 'https://example.com/"><script>alert(1)</script>' });
    expect(output).not.toContain('<script>');
    expect(output).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('matchLinkIcon (deprecated alias of matchLink)', () => {
  it('renders identically to matchLink when map is known', () => {
    const output = matchLinkIcon({ url: 'https://tracker.gg/valorant/match/abc123', mapName: 'Ascent' });
    expect(output).toBe(
      `<a href="https://tracker.gg/valorant/match/abc123">${mapToEmojiHtml('Ascent')} Ascent</a>`,
    );
  });

  it('renders name-only link when map is not in the emoji pack', () => {
    const output = matchLinkIcon({ url: 'https://tracker.gg/valorant/match/abc123', mapName: 'Bogus Map' });
    expect(output).toBe('<a href="https://tracker.gg/valorant/match/abc123">Bogus Map</a>');
  });

  it('falls back to the word "матч" when map is absent', () => {
    const output = matchLinkIcon({ url: 'https://tracker.gg/valorant/match/abc123' });
    expect(output).toBe('<a href="https://tracker.gg/valorant/match/abc123">матч</a>');
  });

  it('HTML-escapes the url', () => {
    const output = matchLinkIcon({ url: 'https://example.com/"><script>alert(1)</script>' });
    expect(output).not.toContain('<script>');
  });
});
