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
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `🎯 <b>AAAAAAACE!</b> ${playerTag(user)} — 5 фрагов в раунде${roundCount}${mapStr}${matchLink}${opponentsStr}`;
  },

  ace_rare_weapon_week: (payload, user, match) => {
    const weaponsPerRound = Array.isArray(payload['weapons_per_round']) ? payload['weapons_per_round'] as string[][] : [];
    const KNIFE_TOKENS = new Set(['Knife', '2f59173c-4bed-b6c3-2191-dea9b58be9c7']);
    const CLASSIC_TOKENS = new Set(['Classic', '29a0cfab-485b-f5d5-779a-b59f85e204a8']);

    const rareNames = new Set<string>();
    for (const round of weaponsPerRound) {
      if (!Array.isArray(round)) continue;
      for (const w of round) {
        if (KNIFE_TOKENS.has(w)) rareNames.add('Knife');
        else if (CLASSIC_TOKENS.has(w)) rareNames.add('Classic');
      }
    }
    const weaponStr = Array.from(rareNames).join(', ') || 'редким';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `💎 ${playerTag(user)} знает толк в извращениях. Эйс — <b>${esc(weaponStr)}</b>${mapStr}${matchLink}`;
  },

  rank_promo: (payload, user, _match) => {
    const to = payload['to'] ?? '';
    const rankEmoji = rankToEmojiHtml(to as string);
    if (rankEmoji) {
      return `🎖 <b>Повышение по службе</b> — ${playerTag(user)} ${rankEmoji} ${esc(String(to))}`;
    }
    if (to) {
      return `🎖 <b>Повышение по службе</b> — ${playerTag(user)} ${esc(String(to))}`;
    }
    return `🎖 <b>Повышение по службе</b> — ${playerTag(user)}`;
  },

  winstreak_10plus: (payload, user, _match) => {
    const streak = payload['streak'] ?? 10;
    return `🔥 <b>Винстрик:</b> ${playerTag(user)} — ${esc(String(streak))} побед подряд`;
  },

  giant_slayer: (payload, user, match) => {
    const own = payload['own'] ?? '';
    const enemy = payload['enemy_avg'] ?? '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `🦣 ${playerTag(user)} (${esc(String(own))}) — <b>машина для убийства</b>, победа в матче с превосходящим врагом, средний ранг противника — ${esc(String(enemy))}${matchLink}`;
  },

  return_after_pause: (payload, user, _match) => {
    const days = payload['days_paused'] ?? '?';
    return `👋 <b>С возвращением</b>, ${playerTag(user)}! После ${esc(String(days))} дней паузы снова в строю`;
  },

  teamkill: (payload, user, match) => {
    const roundNumbers = Array.isArray(payload['round_numbers']) ? payload['round_numbers'] : [];
    const count = roundNumbers.length > 0 ? ` (${roundNumbers.length}× за матч)` : '';
    const victimNames = Array.isArray(payload['victim_names_for_template']) ? payload['victim_names_for_template'] as string[] : [];
    const uniqueVictims = Array.from(new Set(victimNames.filter((n) => n && n.length > 0)));
    const victimStr = uniqueVictims.length > 0 ? ` (${uniqueVictims.map((n) => `<b>${esc(n)}</b>`).join(', ')})` : '';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `🐀 <b>Ля ты и крыса</b>, ${playerTag(user)} — стрельнул в своего${victimStr}${count}${mapStr}${matchLink}`;
  },

  fall_damage_death: (payload, user, match) => {
    const count = payload['count'] ? ` (${esc(String(payload['count']))}×)` : '';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `🪂 ${playerTag(user)} — <b>звезда паркура против гравитации, 1:0 в пользу гравитации</b> (смерть от падения)${count}${mapStr}${matchLink}`;
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

  knife_kill: (payload, user, match) => {
    const count = Number(payload['count'] ?? 1);
    const countStr = count > 1 ? ` ${count} врагов` : ' врага';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `🔪 <b>Заколол баранчика</b> ${playerTag(user)} — зарезал${countStr} с ножа${mapStr}${matchLink}`;
  },

  match_comeback: (payload, user, match) => {
    const dp = payload['deficit_score_player'] ?? '?';
    const dop = payload['deficit_score_opponent'] ?? '?';
    const fp = payload['final_score_player'] ?? '?';
    const fop = payload['final_score_opponent'] ?? '?';
    const mapStr = match?.map ? ` на ${esc(match.map)}` : '';
    const matchLink = match?.match_id ? ` · <a href="https://tracker.gg/valorant/match/${esc(match.match_id)}">→ матч</a>` : '';
    return `👏 <b>Мы вами гордимся</b>, ${playerTag(user)}\n🥂 проигрывали со счётом ${dp}:${dop}\nно закончили победой ${fp}:${fop}${mapStr}${matchLink}`;
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
