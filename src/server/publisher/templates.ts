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

/** Match-link line for realtime templates — separated from the body by a blank line. */
function matchLine(match_id: string): string {
  return `\n\n<a href="https://tracker.gg/valorant/match/${esc(match_id)}">Ссылка на матч</a>`;
}

/** Inline match-link suffix for digest templates — joined with " | " separator. */
function matchLinkInline(match_id: string | undefined): string {
  if (!match_id) return '';
  return ` | <a href="https://tracker.gg/valorant/match/${esc(match_id)}">Ссылка на матч</a>`;
}

/** Wraps a context-description line in italic + underline for digest templates. */
function ctxLine(text: string): string {
  return `<i><u>${text}</u></i>`;
}

function mapSuffix(map: string | undefined): string {
  return map ? ` на карте ${esc(map)}` : '';
}

/**
 * Context-description for record_* templates — explains what statistic the
 * record measures. Goes between the funny header and the value line.
 * Returns null for non-record types or types that already self-describe.
 */
function recordContextLine(eventType: EventType): string | null {
  switch (eventType) {
    case 'record_kills_match':           return 'рекорд по количеству фрагов за игру';
    case 'record_deaths_match':          return 'рекорд по количеству смертей за игру';
    case 'record_headshots_match':       return 'рекорд по количеству хедшотов за игру';
    case 'record_legshots_match':        return 'рекорд по количеству легшотов за игру';
    case 'record_damage_dealt_match':    return 'рекорд по нанесённому урону за игру';
    case 'record_damage_received_match': return 'рекорд по полученному урону за игру';
    case 'record_mvp_count_week':        return 'рекорд по количеству MVP-матчей за неделю';
    // record_kills_per_weapon, record_longest_match_minutes,
    // record_longest_match_rounds — context line is already inside their body
    default: return null;
  }
}

/**
 * Render the "prev record" line for digest record_* templates.
 * Returns either '' (first record) or '\n…' line to append inside <blockquote>.
 */
function prevRecordLine(
  prevValue: unknown,
  prevName: unknown,
  prevTag: unknown,
  prevPuuid: unknown,
  ownPuuid: string | undefined,
  unit?: string,
): string {
  if (prevValue === null || prevValue === undefined) return '';
  const unitStr = unit ? ` ${unit}` : '';
  const samePlayer = prevPuuid === ownPuuid;
  if (samePlayer) {
    return `\nпрошлый рекорд: ${esc(String(prevValue))}${unitStr} (тоже его)`;
  }
  if (prevName) {
    const tag = prevTag ? '#' + esc(String(prevTag)) : '';
    return `\nпрошлый рекорд: ${esc(String(prevValue))}${unitStr} у <b>${esc(String(prevName))}${tag}</b>`;
  }
  return `\nпрошлый рекорд: ${esc(String(prevValue))}${unitStr}`;
}

const templates: Record<EventType, TemplateFn> = {
  ace: (_payload, user, match) => {
    const weaponsPerRound = Array.isArray(_payload['weapons_per_round'])
      ? _payload['weapons_per_round'] as unknown[][]
      : [];
    let maxKills = 5;
    for (const round of weaponsPerRound) {
      if (Array.isArray(round) && round.length > maxKills) {
        maxKills = round.length;
      }
    }
    const killsStr = maxKills > 5 ? ` — ${maxKills} убийств` : '';
    const desc = `${playerTag(user)}${killsStr}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🎯 <b>AAAAAAACE!</b>\n\n${desc}${link}`;
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
    const valueLine = `${playerTag(user)} — эйс с ${esc(weaponStr)}${mapSuffix(match?.map)}${matchLinkInline(match?.match_id)}`;
    return `💎 <b>Знает толк в извращениях</b>\n${valueLine}`;
  },

  peak_rank_up: (payload, user, _match) => {
    const to = payload['to_tier_name'] ?? '';
    const rankEmoji = rankToEmojiHtml(to as string);
    let rankPart = '';
    if (to) {
      rankPart = rankEmoji ? ` ${rankEmoji} ${esc(String(to))}` : ` ${esc(String(to))}`;
    }
    const desc = `${playerTag(user)} — поднялся(лась) до${rankPart}`;
    return `🎖 <b>Повышение по службе</b>\n${desc}`;
  },

  winstreak_10plus: (payload, user, _match) => {
    const streak = payload['streak'] ?? 10;
    const desc = `${playerTag(user)} — ${esc(String(streak))} побед подряд`;
    return `🏆 <b>Винстрик недели:</b>\n${desc}`;
  },

  giant_slayer: (payload, user, match) => {
    const own = payload['own'] ?? '';
    const enemy = payload['enemy_avg'] ?? '';
    const ownStr = own ? ` (${esc(String(own))})` : '';
    const enemyStr = enemy ? ` (средний ранг ${esc(String(enemy))})` : '';
    const desc = `${playerTag(user)}${ownStr} — выиграл(а) против превосходящего врага${enemyStr}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `💪 <b>Поводил(ла) по губам</b>\n\n${desc}${link}`;
  },

  return_after_pause: (payload, user, _match) => {
    const days = payload['days_paused'] ?? '?';
    const desc = `${playerTag(user)} — после ${esc(String(days))} дней паузы снова в строю`;
    return `👋 <b>С возвращением</b>\n\n${desc}`;
  },

  teamkill: (payload, user, match) => {
    const roundNumbers = Array.isArray(payload['round_numbers']) ? payload['round_numbers'] : [];
    const count = roundNumbers.length > 1 ? ` (${roundNumbers.length}× за матч)` : '';
    const victimNames = Array.isArray(payload['victim_names_for_template']) ? payload['victim_names_for_template'] as string[] : [];
    const uniqueVictims = Array.from(new Set(victimNames.filter((n) => n && n.length > 0)));
    const victimStr = uniqueVictims.length > 0 ? ` (${uniqueVictims.map((n) => `<b>${esc(n)}</b>`).join(', ')})` : '';
    const desc = `${playerTag(user)} убил(а) своего${victimStr}${count}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🐀 <b>Ля ты и крыса</b>\n\n${desc}${link}`;
  },

  fall_damage_death: (payload, user, match) => {
    const n = Number(payload['count'] ?? 1);
    const countStr = n > 1 ? ` (${n}×)` : '';
    const desc = `${playerTag(user)} — умер(ла) от падения${countStr}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🪂 <b>1:0 в пользу гравитации</b>\n\n${desc}${link}`;
  },

  record_damage_dealt_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_damage_dealt_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} dmg${matchLinkInline(match?.match_id)}`;
    return `🥩 <b>Мясник</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_damage_received_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_damage_received_match');
    const valueLine = `${playerTag(user)} — получил(а) ${esc(String(value))} dmg${matchLinkInline(match?.match_id)}`;
    return `🤕 <b>Груша для битья</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_kills_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_kills_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} фрагов${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `💀 <b>Мирного рішення не буде</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_deaths_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_deaths_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} смертей${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `⚰️ <b>Жертва насилия</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_headshots_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_headshots_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} хедшотов${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `🤠 <b>Директор дикого запада</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_legshots_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_legshots_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} легшотов${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `♿️ <b>Угадай куда шмальну</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  knife_kill: (payload, user, match) => {
    const count = Number(payload['count'] ?? 1);
    const countStr = count > 1 ? `${count} врагов` : 'врага';
    const desc = `${playerTag(user)} — зарезал(а) ${countStr} с ножа${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🔪 <b>Заколол кабанчика</b>\n\n${desc}${link}`;
  },

  record_mvp_count_week: (payload, user, _match) => {
    const value = payload['value'];
    const prevValue = payload['prev_value'];
    // Treat 0 prev_value as "no prev record" (legacy behaviour)
    const prevForLine = (prevValue !== null && prevValue !== undefined && Number(prevValue) > 0) ? prevValue : undefined;
    const prev = prevRecordLine(prevForLine, payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid, 'MVP');
    const ctx = recordContextLine('record_mvp_count_week');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} MVP-матчей`;
    return `🏅 <b>Отказался(лась) от личной жизни</b>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  match_comeback: (payload, user, match) => {
    const dp = payload['deficit_score_player'] ?? '?';
    const dop = payload['deficit_score_opponent'] ?? '?';
    const fp = payload['final_score_player'] ?? '?';
    const fop = payload['final_score_opponent'] ?? '?';
    const desc = `${playerTag(user)} — отыгрались с ${dp}:${dop} до ${fp}:${fop}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `👏 <b>Мы вами гордимся</b>\n\n${desc}${link}`;
  },

  record_kills_per_weapon: (payload, user, _match) => {
    const weapon = payload['weapon'] ?? '?';
    const value = payload['value'];
    const realMatchId = payload['real_match_id'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = 'самое большое количество убийств за игру из одного оружия';
    const valueLine = `${playerTag(user)} — ${esc(String(value))} фрагов${matchLinkInline(realMatchId ? String(realMatchId) : undefined)}`;
    return `🔫 <b>Эксперт по ${esc(String(weapon))}</b>\n${ctxLine(ctx)}\n${valueLine}${prev}`;
  },

  record_longest_match_minutes: (payload, user, match) => {
    const value = payload['value'];
    const players = Array.isArray(payload['community_players'])
      ? payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>
      : [];
    const playerNames = players
      .map((p) => p.name ? `<b>${esc(p.name)}</b>` : '')
      .filter((s) => s)
      .join(', ') || playerTag(user);
    const verb = players.length > 1 ? 'проинвестировали' : 'проинвестировал(а)';
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid, 'минут');
    const ctx = 'рекорд по длительности матча';
    const valueLine = `${esc(String(value))} минут${mapSuffix(match?.map)}${matchLinkInline(match?.match_id)}`;
    return `⏳ <b>${playerNames} — ${verb} свое время правильно</b>\n${ctxLine(ctx)}\n${valueLine}${prev}`;
  },

  record_longest_match_rounds: (payload, user, match) => {
    const value = payload['value'];
    const players = Array.isArray(payload['community_players'])
      ? payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>
      : [];
    const playerNames = players
      .map((p) => p.name ? `<b>${esc(p.name)}</b>` : '')
      .filter((s) => s)
      .join(', ') || playerTag(user);
    const verb = players.length > 1 ? 'пережили' : 'пережил(а)';
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid, 'раундов');
    const ctx = 'рекорд по количеству раундов в матче';
    const valueLine = `${playerNames} — ${verb} ${esc(String(value))} раундов${mapSuffix(match?.map)}${matchLinkInline(match?.match_id)}`;
    return `😰 <b>Надеюсь это того стоило</b>\n${ctxLine(ctx)}\n${valueLine}${prev}`;
  },

  community_clash: (payload, _user, match) => {
    const teams = Array.isArray(payload['teams'])
      ? payload['teams'] as Array<{ team_id: string; players: Array<{ puuid: string; name: string | null; tag: string | null }> }>
      : [];
    const winnerTeamId = payload['winner_team_id'] as string | null | undefined;

    const renderTeam = (idx: number, players: Array<{ puuid: string; name: string | null; tag: string | null }>) => {
      const namesList = players
        .map((p) => p.name ? `<b>${esc(p.name)}</b>` : `<b>${esc(p.puuid)}</b>`)
        .join(', ');
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
    return `⚔️ <b>Френдлифаер</b>\n\n${desc}${link}`;
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

/**
 * Render a digest group block for group-capable digest event types
 * (winstreak_10plus, peak_rank_up, ace_rare_weapon_week) when ≥2 entries of the
 * same event_type fall into one week.
 *
 * Other event types fall back to joined per-event renderTemplate calls — but the
 * digest builder normally won't call this with non-group-capable types when N>1
 * because those are ≤1/week by design.
 */
export interface DigestEntry {
  payload: Record<string, unknown>;
  user: TemplateUser;
  match?: TemplateMatch;
}

export function renderDigestGroup(eventType: EventType, entries: DigestEntry[]): string {
  if (entries.length === 0) return '';

  if (eventType === 'winstreak_10plus') {
    const lines = entries
      .map((e) => ({
        streak: Number(e.payload['streak'] ?? 0),
        line: `${playerTag(e.user)} — ${esc(String(e.payload['streak'] ?? 10))} побед подряд`,
      }))
      .sort((a, b) => b.streak - a.streak)
      .map((x) => x.line);
    return `🏆 <b>Винстрик недели:</b>\n${lines.join('\n')}`;
  }

  if (eventType === 'peak_rank_up') {
    const lines = entries.map((e) => {
      const to = e.payload['to_tier_name'] ?? '';
      const rankEmoji = rankToEmojiHtml(to as string);
      let rankPart = '';
      if (to) {
        rankPart = rankEmoji ? ` ${rankEmoji} ${esc(String(to))}` : ` ${esc(String(to))}`;
      }
      return `${playerTag(e.user)} — поднялся(лась) до${rankPart}`;
    });
    const header = entries.length === 1 ? 'Повышение по службе' : 'Повышения по службе';
    return `🎖 <b>${header}</b>\n${lines.join('\n')}`;
  }

  if (eventType === 'ace_rare_weapon_week') {
    const KNIFE_TOKENS = new Set(['Knife', '2f59173c-4bed-b6c3-2191-dea9b58be9c7']);
    const CLASSIC_TOKENS = new Set(['Classic', '29a0cfab-485b-f5d5-779a-b59f85e204a8']);
    const lines = entries.map((e) => {
      const weaponsPerRound = Array.isArray(e.payload['weapons_per_round']) ? e.payload['weapons_per_round'] as string[][] : [];
      const rareNames = new Set<string>();
      for (const round of weaponsPerRound) {
        if (!Array.isArray(round)) continue;
        for (const w of round) {
          if (KNIFE_TOKENS.has(w)) rareNames.add('Knife');
          else if (CLASSIC_TOKENS.has(w)) rareNames.add('Classic');
        }
      }
      const weaponStr = Array.from(rareNames).join(', ') || 'редким';
      return `${playerTag(e.user)} — эйс с ${esc(weaponStr)}${mapSuffix(e.match?.map)}${matchLinkInline(e.match?.match_id)}`;
    });
    const header = entries.length === 1 ? 'Знает толк в извращениях' : 'Знают толк в извращениях';
    return `💎 <b>${header}</b>\n${lines.join('\n')}`;
  }

  // Fallback: not group-capable but called anyway — render each event individually.
  return entries.map((e) => renderTemplate(eventType, e.payload, e.user, e.match)).join('\n\n');
}
