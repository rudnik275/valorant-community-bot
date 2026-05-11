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
}

type TemplateFn = (
  payload: Record<string, unknown>,
  user: TemplateUser,
  match?: TemplateMatch,
) => string;

function playerTag(user: TemplateUser): string {
  return `<b>${esc(user.riot_name + '#' + user.riot_tag)}</b>`;
}

/**
 * Render opponents' peak ranks as an addendum to ace/clutch messages.
 *
 * Victims are listed in kill order from `victim_names_for_template` (may be empty strings).
 * For each victim, peak rank comes from `opponents_peak[puuid].tier_name` if present.
 * If both name and peak are missing for a victim, that victim is omitted from the line.
 */
function renderOpponentsPeak(payload: Record<string, unknown>): string {
  const opponentsPeak = payload['opponents_peak'] as Record<string, { tier_id: number; tier_name: string; season_short: string }> | undefined;
  const victims = payload['victims'] as Array<{ puuid: string; name: string; tag: string }> | undefined;
  const victimNames = payload['victim_names_for_template'] as string[] | undefined;

  if (!opponentsPeak || Object.keys(opponentsPeak).length === 0) return '';
  if (!victims || victims.length === 0) return '';

  const parts: string[] = [];

  for (let i = 0; i < victims.length; i++) {
    const victim = victims[i]!;
    const displayName = (victimNames?.[i] ?? victim.name) || null;
    const peak = opponentsPeak[victim.puuid];

    if (displayName && peak) {
      parts.push(`${esc(displayName)} (peak ${esc(peak.tier_name)})`);
    } else if (displayName) {
      parts.push(esc(displayName));
    } else if (peak) {
      parts.push(`peak ${esc(peak.tier_name)}`);
    }
    // If neither name nor peak — skip this victim
  }

  if (parts.length === 0) return '';
  return `\n💥 Жертвы: ${parts.join(', ')}`;
}

const templates: Record<EventType, TemplateFn> = {
  ace: (payload, user, match) => {
    const rounds = Array.isArray(payload['rounds']) ? payload['rounds'] : [];
    const roundCount = rounds.length > 1 ? ` (${rounds.length}×)` : '';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const opponentsStr = renderOpponentsPeak(payload);
    return `🎯 Эйс! У ${playerTag(user)} 5 убийств в раунде${roundCount}${mapStr}${opponentsStr}`;
  },

  ace_rare_weapon: (payload, user, match) => {
    const weapons = Array.isArray(payload['weapons']) ? payload['weapons'] : [];
    const weaponsStr = weapons.length > 0
      ? ` (${weapons.map((w) => esc(String(w))).join(', ')})`
      : '';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    return `🔪 Эйс редким оружием! ${playerTag(user)}${mapStr}${weaponsStr}`;
  },

  rank_promo: (payload, user, _match) => {
    const toRank = payload['to'] != null ? String(payload['to']) : null;
    const toIcon = rankToEmojiHtml(toRank);
    const toFamily = toRank ? (toRank.split(' ')[0] ?? '') : '';

    if (toRank && toIcon && toFamily) {
      return `📈 ${playerTag(user)} апнул ранг — ${toIcon} ${esc(toFamily)}`;
    }
    if (toRank) {
      // Unknown rank label (rank-emoji map miss) — keep full label as-is
      return `📈 ${playerTag(user)} апнул ранг — ${esc(toRank)}`;
    }
    return `📈 ${playerTag(user)} апнул ранг`;
  },

  winstreak_9: (payload, user, _match) => {
    const streak = payload['streak'] ?? 9;
    return `🔥 Винстрик! ${streak} побед подряд у ${playerTag(user)}`;
  },

  giant_slayer: (payload, user, _match) => {
    const enemyAvg = payload['enemy_avg'] ? ` рангом ${esc(String(payload['enemy_avg']))}` : '';
    const own = payload['own'] ? ` (ранг: ${esc(String(payload['own']))})` : '';
    return `⚔️ Гигантоборец! ${playerTag(user)} взял команду${enemyAvg}${own}`;
  },

  return_after_pause: (payload, user, _match) => {
    const days = payload['days_paused'] ? `${esc(String(payload['days_paused']))} дней` : 'долгого перерыва';
    return `👋 С возвращением! ${playerTag(user)} снова в строю после ${days}`;
  },

  teamkill: (payload, user, _match) => {
    const roundNumbers = Array.isArray(payload['round_numbers']) ? payload['round_numbers'] : [];
    const count = roundNumbers.length > 0 ? roundNumbers.length : payload['count'] ?? '?';
    return `🤦 ${playerTag(user)} случайно своих... (${count}× за матч)`;
  },

  fall_damage_death: (payload, user, match) => {
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const count = payload['count'] ? ` (${esc(String(payload['count']))}×)` : '';
    return `🤡 ${playerTag(user)} встретился с гравитацией${mapStr}${count}`;
  },

  record_kills_match: (payload, user, match) => {
    const value = payload['value'];
    const prevValue = payload['prev_value'];
    const prevPuuid = payload['prev_puuid'];
    const samePlayer = prevPuuid === user.riot_puuid;
    const prevStr = prevValue !== null && prevValue !== undefined
      ? samePlayer
        ? ` (прошлый: ${esc(String(prevValue))}, тоже его)`
        : ` (прошлый: ${esc(String(prevValue))})`
      : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(match.match_id))}">→ матч</a>` : '';
    return `🔪 <b>Мирного рішення не буде:</b> ${playerTag(user)} — ${esc(String(value))} фрагов${prevStr}${matchLink}`;
  },
};

/**
 * Render a template for the given event_type.
 * Returns a fallback string if event_type is unknown.
 */
export function renderTemplate(
  eventType: EventType,
  payload: Record<string, unknown>,
  user: TemplateUser,
  match?: TemplateMatch,
): string {
  const fn = templates[eventType];
  if (!fn) {
    return `📢 Новое событие у ${playerTag(user)}`;
  }
  return fn(payload, user, match);
}
