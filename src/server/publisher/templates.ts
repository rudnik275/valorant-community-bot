/**
 * templates.ts — Message templates for each EventType.
 *
 * Each template renders an HTML-formatted string for Telegram (parse_mode=HTML).
 * User-supplied strings (riot_name, riot_tag, etc.) are HTML-escaped via `esc()`
 * to prevent injection.
 *
 * Template signature: (payload, user, match?) => string
 * The `match` param is optional — only fetched when needed.
 */

import type { EventType } from './types.ts';
import { rankToEmojiHtml } from './rank-emoji.ts';
import { agentToEmojiHtml, mapToEmojiHtml, weaponToEmojiHtml } from './valorant-emoji.ts';
import { renderPlayerName, matchLink as renderMatchLink } from './player-render.ts';

/**
 * HTML-escape a string to prevent injection in Telegram HTML messages.
 * Replaces <, >, &, ", ' with safe HTML entities.
 */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TemplateUser {
  riot_name: string;
  riot_tag: string;
  telegram_id: number;
  riot_puuid?: string;
}

export interface TemplateMatch {
  map?: string;
  match_id?: string;
  /** Agent the triggering player ran this match — rendered as a custom emoji next to their nick. */
  agent?: string;
  /**
   * Triggering player's rank in this match (`match_records.rank_after`) —
   * rendered as a custom emoji LEFT of their nick per renderPlayerName (#315).
   * Absent ⇒ rank icon omitted (never a blocker).
   */
  rank?: string;
  /**
   * teamkill only: victims resolved by the publisher loop / replay from the
   * event payload + match roster (see match-info.ts). Absent ⇒ the template
   * falls back to raw payload victims (no rank).
   */
  victims?: TemplateVictim[];
}

/** One teamkill victim, as resolved by match-info.ts (payload ∪ roster). */
export interface TemplateVictim {
  name: string;
  tag?: string;
  agent?: string;
  /** Victim's rank in this match (`match_rosters.tier`); absent pre-migration-0021. */
  rank?: string;
}

type TemplateFn = (
  payload: Record<string, unknown>,
  user: TemplateUser,
  match?: TemplateMatch,
) => string;

function playerTag(user: TemplateUser): string {
  return `<b>${esc(user.riot_name + '#' + user.riot_tag)}</b>`;
}

/** Match-link line for realtime templates — separated from the body by a blank line. */
function matchLine(match_id: string): string {
  return `\n\n<a href="https://tracker.gg/valorant/match/${esc(match_id)}">матч</a>`;
}

/** Map custom-emoji icon followed by a space, or '' when the map is unknown. */
function mapIcon(map: string | undefined): string {
  const e = mapToEmojiHtml(map);
  return e ? `${e} ` : '';
}


/**
 * Agent custom-emoji suffix for a player nick: a leading space + emoji, or ''
 * when the agent is unknown (older matches, missing roster). Append directly
 * after the bold nick: `${playerTag(user)}${agentLead(match?.agent)}`.
 */
function agentLead(agent: string | null | undefined): string {
  const e = agentToEmojiHtml(agent);
  return e ? ` ${e}` : '';
}

function mapSuffix(map: string | undefined): string {
  return map ? ` на карте ${mapIcon(map)}${esc(map)}` : '';
}

/**
 * Match-link on its OWN line for the minimal realtime templates (teamkill,
 * return_after_pause — #315). The owner explicitly ordered
 * the separate line for teamkill; extended to the family for consistency.
 * Empty when there's no match_id to link to.
 */
/**
 * Match-link line for the short events. A BLANK line separates it from the
 * description above (owner, 2026-08-04: these messages are only three lines,
 * so they read better with air around each one).
 */
function minimalMatchLine(match?: TemplateMatch): string {
  if (!match?.match_id) return '';
  const link = renderMatchLink({
    url: `https://tracker.gg/valorant/match/${match.match_id}`,
    ...(match.map ? { mapName: match.map } : {}),
  });
  return `\n\n${link}`;
}

/** Build renderPlayerName options for the triggering user in the minimal
 * realtime templates — bold (community), rank (match_records.rank_after) and
 * agent from the loop-resolved match info when known (#315). */
function minimalPlayerName(user: TemplateUser, match?: TemplateMatch): string {
  return renderPlayerName({
    name: user.riot_name,
    tag: user.riot_tag,
    isCommunity: true,
    ...(match?.rank ? { rank: match.rank } : {}),
    ...(match?.agent ? { agent: match.agent } : {}),
  });
}

/**
 * Teamkill victim render: full renderPlayerName when the tag is known
 * (victims are community members ⇒ bold; rank/agent icons when resolvable).
 * Legacy payloads without a tag degrade to the old bold-name + agent-emoji
 * form — a `Ник#` with a dangling hash would be worse than no tag.
 */
function renderVictim(v: TemplateVictim): string {
  if (v.tag) {
    return renderPlayerName({
      name: v.name,
      tag: v.tag,
      isCommunity: true,
      ...(v.rank ? { rank: v.rank } : {}),
      ...(v.agent ? { agent: v.agent } : {}),
    });
  }
  return `<b>${esc(v.name)}</b>${agentLead(v.agent)}`;
}

/**
 * Chat templates, keyed by event type. Partial by design: ONLY realtime types
 * have one. Every weekly type (records, winstreaks, rank-ups, ace/knife) is
 * rendered by the digest from its own model (`digest/rich-render.ts`), so
 * their templates live there and are not duplicated here.
 *
 * `renderTemplate` falls back to a generic line for anything missing, and a
 * test asserts each realtime type resolves to a real template.
 */
/**
 * One community player as the `community_clash` detector stores them — the
 * payload carries the tag (the detector reads `riot_name` / `riot_tag` off the
 * joined `users` row), both nullable in that table.
 */
interface ClashPlayer {
  puuid: string;
  name: string | null;
  tag: string | null;
  agent?: string | null;
}

/**
 * One clash roster entry, named like every other nick in the bot: `Ник#Тег`
 * through `renderPlayerName` (#315). This template printed the bold display
 * name ALONE, so two members who share a Riot display name came out as the
 * same line twice and read as a duplicate — while the rich table for the same
 * event named them in full. No rank icon here: the payload has no per-match
 * tier (the rich path reads it from `match_rosters`), and `renderPlayerName`
 * simply omits the icon it wasn't given. A player whose `users.riot_tag` is
 * NULL degrades to the bold nick, exactly as `renderVictim` does — a `Ник#`
 * with a dangling hash would be worse than no tag.
 */
function renderClashPlayer(p: ClashPlayer): string {
  if (!p.name) return `<b>${esc(p.puuid)}</b>`;
  if (!p.tag) return `<b>${esc(p.name)}</b>${agentLead(p.agent)}`;
  return renderPlayerName({
    name: p.name,
    tag: p.tag,
    isCommunity: true,
    ...(p.agent ? { agent: p.agent } : {}),
  });
}

/**
 * One community player's slice of a match-level event: their own payload, user
 * row and resolved match context (agent / rank / victims are all per-player).
 */
export interface EventSubject {
  payload: Record<string, unknown>;
  user: TemplateUser;
  match?: TemplateMatch;
}

/**
 * Realtime templates whose body names ONE community player per line.
 *
 * A single match can trigger the same event for several community members —
 * two friends on the winning team both beat a stronger enemy, two of them both
 * teamkilled, three come back from a pause together. Each is its own
 * `detected_events` row, and the loop used to post one message per row: the
 * group got «💪 Поводил(ла) по губам» twice in a row, identical but for the
 * nick (owner, 2026-08-09). Splitting a template into title + per-player
 * description + shared match link lets the publisher render the whole match as
 * ONE message: title once, one description line per player.
 *
 * The other realtime types (match_comeback / community_clash) already describe
 * the whole match — every player's copy is byte-identical — so they stay whole
 * functions in `templates` below and a group renders from its first subject.
 */
interface PerHeroTemplate {
  /** Heading line, rendered once per message. */
  title: string;
  /** One line per community player. */
  describe: TemplateFn;
  /** Trailing match link, rendered once from the first subject's match. */
  link: (match?: TemplateMatch) => string;
}

const perHeroTemplates: Partial<Record<EventType, PerHeroTemplate>> = {
  giant_slayer: {
    title: '💪 <u>Поводил(ла) по губам</u>',
    describe: (payload, user, match) => {
      const own = payload['own'] ?? '';
      const enemy = payload['enemy_avg'] ?? '';
      // Own + enemy-average rank → emoji only (text dropped, falls back to text
      // when the tier has no custom emoji). See #301.
      const ownEmoji = rankToEmojiHtml(own as string);
      const enemyEmoji = rankToEmojiHtml(enemy as string);
      const ownStr = ownEmoji ? ` ${ownEmoji}` : (own ? ` (${esc(String(own))})` : '');
      const enemyStr = enemyEmoji ? ` ${enemyEmoji}` : (enemy ? ` (средний ранг ${esc(String(enemy))})` : '');
      return `${playerTag(user)}${agentLead(match?.agent)}${ownStr} — выиграл(а) против превосходящего врага${enemyStr}`;
    },
    link: (match) => (match?.match_id ? matchLine(match.match_id) : ''),
  },

  return_after_pause: {
    title: '👋 <b>С возвращением</b>',
    describe: (payload, user, match) => {
      const days = payload['days_paused'] ?? '?';
      const name = minimalPlayerName(user, match);
      return `${name} — после ${esc(String(days))} дней паузы снова в строю`;
    },
    link: minimalMatchLine,
  },

  teamkill: {
    title: '🐀 <b>Ля ты и крыса</b>',
    describe: (payload, user, match) => {
      const roundNumbers = Array.isArray(payload['round_numbers']) ? payload['round_numbers'] : [];
      const count = roundNumbers.length > 1 ? ` (${roundNumbers.length}× за матч)` : '';
      // Victims: prefer the loop-resolved list (match.victims — tag/agent/rank
      // enriched from the match roster, see match-info.ts). Fall back to raw
      // payload victims (name/tag/agent, no rank), then to the legacy names-only
      // array — old events and minimal test payloads must still render.
      const victims: TemplateVictim[] = match?.victims ?? (
        Array.isArray(payload['victims'])
          ? (payload['victims'] as Array<{ name?: string; tag?: string; agent?: string }>)
              .filter((v): v is { name: string; tag?: string; agent?: string } =>
                typeof v.name === 'string' && v.name.length > 0)
          : Array.isArray(payload['victim_names_for_template'])
            ? (payload['victim_names_for_template'] as unknown[])
                .filter((n): n is string => typeof n === 'string' && n.length > 0)
                .map((name) => ({ name }))
            : []
      );
      // Dedup by nick, first-seen wins (keeps the first agent/rank if a victim
      // somehow appears twice).
      const byName = new Map<string, TemplateVictim>();
      for (const v of victims) {
        if (v.name && !byName.has(v.name)) byName.set(v.name, v);
      }
      const victimParts = Array.from(byName.values()).map(renderVictim);
      const victimStr = victimParts.length > 0 ? ` (${victimParts.join(', ')})` : '';
      const name = minimalPlayerName(user, match);
      return `${name} убил(а) своего${victimStr}${count}`;
    },
    link: minimalMatchLine,
  },
};

const templates: Partial<Record<EventType, TemplateFn>> = {
  match_comeback: (payload, user, match) => {
    const dp = payload['deficit_score_player'] ?? '?';
    const dop = payload['deficit_score_opponent'] ?? '?';
    const fp = payload['final_score_player'] ?? '?';
    const fop = payload['final_score_opponent'] ?? '?';
    // Layout: title (plain), summary (italic verb + bold scores), blank line,
    // one community player per line with the 🏅 prefix, blank line, map line
    // where the map name is the tracker link. Falls back to the single
    // triggering user when community_players is absent (older events, tests
    // with minimal payloads).
    const players = Array.isArray(payload['community_players'])
      ? payload['community_players'] as Array<{ puuid: string; name: string; tag: string; agent?: string }>
      : [];
    const playerLines = players
      .map((p) => p.name ? `🏅<b>${esc(p.name)}#${esc(p.tag ?? '')}</b>${agentLead(p.agent)}` : '')
      .filter((s) => s);
    const playersBlock = playerLines.length > 0
      ? playerLines.join('\n')
      : `🏅${playerTag(user)}${agentLead(match?.agent)}`;
    const summary = `<i>отыгрались</i> с <b>${esc(String(dp))}:${esc(String(dop))}</b> до <b>${esc(String(fp))}:${esc(String(fop))}</b>`;
    let bottom = '';
    const mIcon = match?.map ? (mapToEmojiHtml(match.map) || '🗺️') : '🗺️';
    if (match?.map && match?.match_id) {
      bottom = `\n\n${mIcon} <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">${esc(match.map)}</a>`;
    } else if (match?.map) {
      bottom = `\n\n${mIcon} ${esc(match.map)}`;
    } else if (match?.match_id) {
      bottom = matchLine(match.match_id);
    }
    return `👏 Мы вами гордимся\n${summary}\n\n${playersBlock}${bottom}`;
  },

  community_clash: (payload, _user, match) => {
    const teams = Array.isArray(payload['teams'])
      ? payload['teams'] as Array<{ team_id: string; players: ClashPlayer[] }>
      : [];
    const winnerTeamId = payload['winner_team_id'] as string | null | undefined;

    const renderTeam = (idx: number, players: ClashPlayer[]) => {
      const namesList = players.map(renderClashPlayer).join(', ');
      return `Команда ${idx + 1}: ${namesList}`;
    };

    const lines: string[] = [];
    teams.forEach((t, i) => lines.push(renderTeam(i, t.players)));

    if (winnerTeamId) {
      const winnerIdx = teams.findIndex((t) => t.team_id === winnerTeamId);
      if (winnerIdx >= 0) {
        lines.push(`🥇 Команда ${winnerIdx + 1}${mapSuffix(match?.map)}`);
      } else {
        lines.push(`🏳️ Ничья${mapSuffix(match?.map)}`);
      }
    } else {
      lines.push(`🏳️ Ничья${mapSuffix(match?.map)}`);
    }

    const desc = lines.join('\n');
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `⚔️ <u>Френдлифаер</u>\n\n${desc}${link}`;
  },
};

/**
 * Render a template for the given event_type.
 * Returns a fallback string if event_type is unknown.
 */
/**
 * Render the chat message for one REALTIME event.
 *
 * Only realtime event types have a template here. `ace` / `knife_kill` used to
 * have one (the «Заколол баранчика» post) and the record_* types were rendered
 * from here into the old legacy digest text — both paths are gone: ace/knife
 * are weekly counts now (`digest/ace-knife.ts`) and the digest renders from its
 * own model (`digest/rich-render.ts`). An unknown type falls back to a generic
 * line rather than throwing.
 */
export function renderTemplate(
  eventType: EventType,
  payload: Record<string, unknown>,
  user: TemplateUser,
  match?: TemplateMatch,
): string {
  return renderGroupedTemplate(eventType, [
    { payload, user, ...(match ? { match } : {}) },
  ]);
}

/**
 * Render ONE chat message covering every community player the event fired for
 * in a single match — the publisher's per-match uniqueness guarantee.
 *
 * `subjects` must all belong to the same match and event type, ordered oldest
 * first. For a per-hero template the title and match link render once and each
 * subject contributes a description line; for the match-level templates
 * (match_comeback / community_clash) the first subject renders alone, since the
 * others would produce the identical text. A single subject renders exactly
 * what {@link renderTemplate} always did.
 */
export function renderGroupedTemplate(
  eventType: EventType,
  subjects: EventSubject[],
): string {
  const first = subjects[0];
  if (!first) return '';

  const perHero = perHeroTemplates[eventType];
  if (perHero) {
    const lines = subjects.map((s) => perHero.describe(s.payload, s.user, s.match));
    return `${perHero.title}\n\n${lines.join('\n')}${perHero.link(first.match)}`;
  }

  const fn = templates[eventType];
  if (!fn) {
    return `📢 Новое событие у ${playerTag(first.user)}`;
  }
  return fn(first.payload, first.user, first.match);
}

