/**
 * player-render.ts — Foundation helpers for rendering a player's name and a
 * match link, per the global rules in issue #315 / #312.
 *
 * These are pure string builders — no call sites are rewired yet (that's
 * slices B–E). Every existing template keeps using its own inline rendering
 * until each slice migrates it.
 */

import { rankToEmojiHtml } from './rank-emoji.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from './valorant-emoji.ts';

/**
 * HTML-escape a string to prevent injection in Telegram HTML messages.
 * Mirrors `esc()` in templates.ts (kept duplicated on purpose — small, pure,
 * no cross-module coupling for a one-line helper).
 */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * U+2068 FIRST STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE.
 *
 * Written as escapes rather than literals: these characters are invisible in an
 * editor, and the next person to touch the line would delete them unaware.
 */
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * Wrap user-supplied text in a Unicode bidi isolate.
 *
 * Riot IDs are arbitrary user text and some are written right-to-left. Such a
 * name leaks its direction into whatever contains it: on 2026-08-29 one Arabic
 * nick in a roster flipped an ENTIRE table in the group — «Игрок» and
 * «Агент · K/D» swapped sides, and that table looked nothing like the one above
 * it. The names rendered fine; the container did not.
 *
 * FSI … PDI is exactly the tool for this. The name still renders in its own
 * natural direction, so Arabic reads as Arabic, but it cannot influence the
 * direction of the row, table or message around it.
 *
 * Exported rather than applied inside `renderPlayerName`: only a DIRECTIONAL
 * container is at risk, and wrapping every name everywhere would put invisible
 * characters into every message and every assertion about one. Table cells call
 * it; flat prose lines, where a stray flip is cosmetic rather than structural,
 * deliberately do not.
 */
export function isolateBidi(s: string): string {
  return `${FSI}${s}${PDI}`;
}

export interface RenderPlayerNameOptions {
  /** Riot display name (unescaped). */
  name: string;
  /** Riot tag (unescaped). */
  tag: string;
  /** Community players render bold; non-community (other match participants) render plain. */
  isCommunity: boolean;
  /**
   * Rank label for the match this render is attached to (e.g. "Diamond 3"),
   * as returned by Henrik for that match. Same input type as `rankToEmojiHtml`
   * (used by the existing `peak_rank_up` template). Omit/undefined/unrecognised
   * ⇒ rank icon dropped (not a blocker per spec).
   */
  rank?: string | null;
  /**
   * Agent display name the player ran in the attached match (e.g. "Jett").
   * Same input type as `agentToEmojiHtml`. Omit/undefined/unrecognised ⇒
   * agent icon dropped.
   */
  agent?: string | null;
}

/**
 * Render a player name per the global rules (#312/#315):
 * `[ранг-эмодзи ]<b>Name#Tag</b>[ агент-эмодзи]` for community players, or
 * `[ранг-эмодзи ]Name#Tag[ агент-эмодзи]` (no bold) for others.
 *
 * Rank goes on the LEFT (player's rank in that match), agent on the RIGHT
 * (agent they played that match). Both are omitted when not supplied or
 * unrecognised — this function never blocks on missing match data.
 */
export function renderPlayerName(opts: RenderPlayerNameOptions): string {
  const { name, tag, isCommunity, rank, agent } = opts;

  const rankEmoji = rankToEmojiHtml(rank ?? undefined);
  const rankPart = rankEmoji ? `${rankEmoji} ` : '';

  const agentEmoji = agentToEmojiHtml(agent ?? undefined);
  const agentPart = agentEmoji ? ` ${agentEmoji}` : '';

  const nameTag = esc(`${name}#${tag}`);
  const namePart = isCommunity ? `<b>${nameTag}</b>` : nameTag;

  return `${rankPart}${namePart}${agentPart}`;
}

export interface MatchLinkOptions {
  /** Fully-formed match URL (e.g. tracker.gg link). Not escaped by caller — escaped here. */
  url: string;
  /** Map name for this match (e.g. "Ascent"). Omit/unknown ⇒ no map emoji. */
  mapName?: string | null;
}

/**
 * Render a match link — THE one format for every place the bot links a match
 * (owner rule, 2026-07-23): `<a href="URL">[map-emoji] MapName</a>` — the map
 * emoji + space + map name ARE the link; the word «матч» appears nowhere.
 * Map known but not in the emoji pack ⇒ name-only link. Map absent/unknown ⇒
 * last-resort fallback `<a href="URL">матч</a>` (a link can't be empty).
 */
export function matchLink(opts: MatchLinkOptions): string {
  const { url, mapName } = opts;
  const mapEmoji = mapToEmojiHtml(mapName ?? undefined);
  const label = mapName
    ? `${mapEmoji ? `${mapEmoji} ` : ''}${esc(mapName)}`
    : 'матч';
  return `<a href="${esc(url)}">${label}</a>`;
}

/**
 * @deprecated Alias of `matchLink` — the owner unified the match-link format
 * (map emoji + map name) for prose and table cells alike. Kept so existing
 * call sites keep compiling; new code should call `matchLink` directly.
 */
export function matchLinkIcon(opts: MatchLinkOptions): string {
  return matchLink(opts);
}

/**
 * Match link for a RICH message (`sendRichMessage`). Same visual format as
 * {@link matchLink} — map emoji, space, map name — but the emoji sits OUTSIDE
 * the anchor.
 *
 * Deliberately a separate function: in a Rich Message an `<a>` whose content
 * includes a `<tg-emoji>` does NOT render as a tappable link (owner screenshot,
 * 2026-08-04 — the map name came out plain black), while the identical markup
 * links fine in a normal `sendMessage`. Rich renderers must call this one;
 * classic-HTML templates keep using `matchLink`.
 */
export function richMatchLink(opts: MatchLinkOptions): string {
  const { url, mapName } = opts;
  const icon = mapToEmojiHtml(mapName ?? undefined);
  const label = mapName ? esc(mapName) : 'матч';
  return `${icon ? `${icon} ` : ''}<a href="${esc(url)}">${label}</a>`;
}
