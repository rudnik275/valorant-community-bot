/**
 * rich-variants.ts — PROTOTYPE layouts for the daily «Эйсы и ножи» digest (#365).
 *
 * The production layout (`rich-render.ts`, #346) reads badly on a phone: the
 * `<h2>` title wraps onto two lines and every row carries rank + nick#tag +
 * agent + «·» + map icon + link + round numbers in brackets — so nearly every
 * row wraps too (owner screenshot, 2026-09-07). Rather than iterate blindly,
 * this module renders the SAME per-round rows in three deliberately different
 * layouts that the owner previews side by side in their DM via
 * `/test_daily_digest`. Whichever wins gets promoted into `rich-render.ts`;
 * the others (and this module) go.
 *
 * All three share: an `<h3>` title «🍿 Эйсы и ножи за сутки» (one line at h3
 * size where the h2 needed two) and NO tag on the nick — the group knows each
 * other by name and `#GTZ` was pure noise. They differ in orientation and in
 * how much detail survives:
 *
 *   A «Чисто»       — by TYPE, one line per player+match, all detail minus noise
 *                     🎯 Эйсы
 *                     💎 <b>Ник</b> 🦸 · 🗺 Ascent
 *                     💎 <b>Ник</b> 🦸 ×2 · 🗺 Bind
 *
 *   B «По игрокам»  — by PLAYER, two lines per player, map links kept
 *                     💎 <b>Ник</b>
 *                     🎯 Ascent · 🔪🔪 Bind
 *
 *   C «Табло»       — by PLAYER, one line each, an emoji tally that links
 *                     💎 <b>Ник</b> — 🎯🔪🔪
 *
 * A keeps the chronological order of the production layout. B and C are
 * leaderboards: players sorted by total events (aces + knives) descending,
 * ties by first appearance. The round numbers are gone everywhere — the round
 * an ace happened in is trivia nobody reads, and the 🏆/💀 outcome went with
 * it; the match link is one tap away for anyone who wants the story.
 *
 * Rich HTML facts (verified in #306/#309): `<h3>` renders as a heading, inline
 * `<b>/<a>/<tg-emoji>` pass through, raw `\n` collapses browser-style — so the
 * produced strings carry NO raw `\n` (asserted in tests). `<a>` must not wrap a
 * `<tg-emoji>` (kills the link in rich, see `richMatchLink`); C's tally links
 * wrap UNICODE emoji, which are plain text to the client.
 */

import { renderPlayerName, richMatchLink } from '../publisher/player-render.ts';
import type { RichDailyRow } from './rich-render.ts';

export type DailyVariant = 'A' | 'B' | 'C';

export const DAILY_VARIANTS: readonly DailyVariant[] = ['A', 'B', 'C'];

/** Human label per variant — shown above each preview in the owner's DM. */
export const DAILY_VARIANT_LABELS: Readonly<Record<DailyVariant, string>> = {
  A: 'Чисто',
  B: 'По игрокам',
  C: 'Табло',
};

const TITLE = '<h3>🍿 Эйсы и ножи за сутки</h3>';

/** Blank line between blocks — the weekly digest's idiom for the same gap. */
const GAP = '<br><br>';

/**
 * Past this many events of one type in one place the tally stops repeating
 * the emoji and prints `🔪×6` instead — six knives in a row is a wall.
 */
const TALLY_REPEAT_MAX = 5;

const ACE = '🎯';
const KNIFE = '🔪';

function typeEmoji(t: RichDailyRow['eventType']): string {
  return t === 'ace' ? ACE : KNIFE;
}

function trackerUrl(matchId: string): string {
  return `https://tracker.gg/valorant/match/${matchId}`;
}

function playerKey(r: RichDailyRow): string {
  return `${r.riotName}#${r.riotTag}`;
}

/**
 * `🎯🎯` / `🔪×6` — one type's count as repeated emoji, capped. `href` wraps
 * each glyph (or the `×N` form) in a link to the match; C is the only caller
 * that links, B leads its map link with a bare tally.
 */
function tally(emoji: string, count: number, href?: string): string {
  const body = count > TALLY_REPEAT_MAX ? `${emoji}×${count}` : emoji.repeat(count);
  return href ? `<a href="${href}">${body}</a>` : body;
}

/** Order-preserving group-by: insertion order of first appearance. */
function groupBy<T>(items: T[], key: (t: T) => string): Array<{ key: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    let bucket = map.get(k);
    if (!bucket) {
      bucket = [];
      map.set(k, bucket);
    }
    bucket.push(it);
  }
  return [...map].map(([k, v]) => ({ key: k, items: v }));
}

// ─── A «Чисто» ───────────────────────────────────────────────────────────────

/**
 * Same skeleton as production — 🎯 Эйсы then 🔪 Ножи, one line per
 * player+match — with everything that does not survive a phone width cut:
 * no `#tag`, no round brackets, section labels as bold lines instead of `<h3>`
 * blocks. `×N` stays (bold, on the nick side) when one match holds several.
 */
function renderA(rows: RichDailyRow[]): string {
  const section = (label: string, type: RichDailyRow['eventType']): string | null => {
    const typed = rows.filter((r) => r.eventType === type);
    if (typed.length === 0) return null;
    const lines = groupBy(typed, (r) => `${playerKey(r)}|${r.matchId}`).map(({ items }) => {
      const head = items[0]!;
      const nick = renderPlayerName({
        name: head.riotName,
        tag: head.riotTag,
        isCommunity: true,
        rank: head.rank,
        agent: head.agent || null,
        hideTag: true,
      });
      const multiplier = items.length > 1 ? ` <b>×${items.length}</b>` : '';
      const link = richMatchLink({ url: trackerUrl(head.matchId), mapName: head.map });
      return `${nick}${multiplier} · ${link}`;
    });
    return [`<b>${label}</b>`, ...lines].join('<br>');
  };

  const blocks = [section(`${ACE} Эйсы`, 'ace'), section(`${KNIFE} Ножи`, 'knife_kill')].filter(
    (b): b is string => b !== null,
  );
  return TITLE + blocks.join(GAP);
}

// ─── Shared by B and C: players as a leaderboard ─────────────────────────────

interface PlayerGroup {
  /** Most recent row — its rank is the one shown (the closest to "current"). */
  latest: RichDailyRow;
  rows: RichDailyRow[];
}

/**
 * One group per player, sorted by total events descending, ties by first
 * appearance in `rows` (which build.ts hands over chronologically).
 */
function playerLeaderboard(rows: RichDailyRow[]): PlayerGroup[] {
  return groupBy(rows, playerKey)
    .map(({ items }) => ({
      latest: items.reduce((a, b) => (b.detectedAt >= a.detectedAt ? b : a)),
      rows: items,
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

/** Rank on the left, bold bare nick, no agent — the per-player header. */
function playerHeader(g: PlayerGroup): string {
  return renderPlayerName({
    name: g.latest.riotName,
    tag: g.latest.riotTag,
    isCommunity: true,
    rank: g.latest.rank,
    hideTag: true,
  });
}

// ─── B «По игрокам» ──────────────────────────────────────────────────────────

/**
 * A block per player: the header line, then one line listing their matches
 * as `<tally> <map link>` joined with «·». A match where the same player
 * pulled both an ace and a knife shows once, as `🎯🔪 Haven`, aces first.
 * Agent icons are dropped — they are a per-match fact and the line is per
 * player.
 */
function renderB(rows: RichDailyRow[]): string {
  const blocks = playerLeaderboard(rows).map((g) => {
    const matches = groupBy(g.rows, (r) => r.matchId).map(({ items }) => {
      const head = items[0]!;
      const aces = items.filter((r) => r.eventType === 'ace').length;
      const knives = items.length - aces;
      const marks = tally(ACE, aces) + tally(KNIFE, knives);
      const link = richMatchLink({ url: trackerUrl(head.matchId), mapName: head.map, icon: false });
      return `${marks} ${link}`;
    });
    return `${playerHeader(g)}<br>${matches.join(' · ')}`;
  });
  return TITLE + blocks.join(GAP);
}

// ─── C «Табло» ───────────────────────────────────────────────────────────────

/**
 * One line per player: header, an em dash, then the tally — every ace and
 * knife of the day as one emoji, aces first, each glyph linking to its match.
 * No maps, no agents, no sections: the day's scoreboard at a glance, and the
 * emoji themselves are the way into the matches.
 */
function renderC(rows: RichDailyRow[]): string {
  const lines = playerLeaderboard(rows).map((g) => {
    const byMatch = groupBy(g.rows, (r) => r.matchId);
    const marks = (type: RichDailyRow['eventType']): string =>
      byMatch
        .map(({ items }) => {
          const n = items.filter((r) => r.eventType === type).length;
          return n === 0 ? '' : tally(typeEmoji(type), n, trackerUrl(items[0]!.matchId));
        })
        .join('');
    return `${playerHeader(g)} — ${marks('ace')}${marks('knife_kill')}`;
  });
  return TITLE + lines.join('<br>');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Render the daily digest rows in one prototype layout. The result is Rich
 * HTML for `sendRichMessage` and contains NO raw `\n`. Callers never pass an
 * empty array — build.ts returns `richHtml=null` alongside `rows=[]` and the
 * preview command says so instead of rendering.
 */
export function renderDailyVariant(variant: DailyVariant, rows: RichDailyRow[]): string {
  switch (variant) {
    case 'A':
      return renderA(rows);
    case 'B':
      return renderB(rows);
    case 'C':
      return renderC(rows);
  }
}

/** `'a'`/`'B'` → the variant, anything else → null. */
export function parseDailyVariant(token: string | undefined): DailyVariant | null {
  const up = (token ?? '').trim().toUpperCase();
  return (DAILY_VARIANTS as readonly string[]).includes(up) ? (up as DailyVariant) : null;
}
