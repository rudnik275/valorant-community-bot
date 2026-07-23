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
 * Render a match link for inline prose: `<a href="URL">матч [map-emoji]</a>`.
 * Unknown/absent map ⇒ just `<a href="URL">матч</a>`.
 */
export function matchLink(opts: MatchLinkOptions): string {
  const { url, mapName } = opts;
  const mapEmoji = mapToEmojiHtml(mapName ?? undefined);
  const label = mapEmoji ? `матч ${mapEmoji}` : 'матч';
  return `<a href="${esc(url)}">${label}</a>`;
}

/**
 * Render a match link for table cells: icon-only, `<a href="URL">[map-emoji]</a>`.
 * Unknown/absent map ⇒ falls back to the word link, `<a href="URL">матч</a>`
 * (a table cell can't be a bare "" link).
 */
export function matchLinkIcon(opts: MatchLinkOptions): string {
  const { url, mapName } = opts;
  const mapEmoji = mapToEmojiHtml(mapName ?? undefined);
  const label = mapEmoji || 'матч';
  return `<a href="${esc(url)}">${label}</a>`;
}
