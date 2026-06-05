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
import { mapToEmojiHtml, weaponToEmojiHtml } from './valorant-emoji.ts';

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
  return `\n\n<a href="https://tracker.gg/valorant/match/${esc(match_id)}">матч</a>`;
}

/** Inline match-link suffix for digest templates — joined with " | " separator. */
function matchLinkInline(match_id: string | undefined): string {
  if (!match_id) return '';
  return ` | <a href="https://tracker.gg/valorant/match/${esc(match_id)}">матч</a>`;
}

/** Wraps a context-description line in italic for digest templates. */
function ctxLine(text: string): string {
  return `<i>${text}</i>`;
}

/** Map custom-emoji icon followed by a space, or '' when the map is unknown. */
function mapIcon(map: string | undefined): string {
  const e = mapToEmojiHtml(map);
  return e ? `${e} ` : '';
}

/** Weapon custom-emoji icon, falling back to the given unicode marker. */
function weaponLead(weapon: string | undefined, fallback: string): string {
  return weaponToEmojiHtml(weapon) || fallback;
}

function mapSuffix(map: string | undefined): string {
  return map ? ` на карте ${mapIcon(map)}${esc(map)}` : '';
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
    case 'record_headshots_match':       return 'рекорд по количеству попаданий в голову за игру (не убийств)';
    case 'record_legshots_match':        return 'рекорд по количеству попаданий в ноги за игру (не убийств)';
    case 'record_damage_dealt_match':    return 'рекорд по нанесённому урону за игру';
    case 'record_damage_received_match': return 'рекорд по полученному урону за игру';
    case 'record_mvp_count_week':        return 'рекорд по количеству MVP-матчей за неделю';
    case 'record_survived_last_rounds':  return 'рекорд по количеству раундов в матче, где игрок умирал последним из своей команды';
    case 'record_died_first_rounds':     return 'рекорд по количеству раундов в матче, где игрок умирал первым из своей команды';
    // record_kills_per_weapon, record_longest_match_minutes — context line
    // is already inside their template body.
    default: return null;
  }
}

/**
 * Render the "prev record" line for digest record_* templates.
 * Currently a no-op — user disabled prev-record info everywhere. Kept so
 * call sites don't need surgery; flip implementation here to re-enable.
 */
function prevRecordLine(
  _prevValue: unknown,
  _prevName: unknown,
  _prevTag: unknown,
  _prevPuuid: unknown,
  _ownPuuid: string | undefined,
  _unit?: string,
): string {
  // Per user: do not show the "прошлый рекорд" line in any record template.
  // Kept as a no-op so existing call sites don't need surgery; if anything
  // ever wants to re-introduce previous-record context, change here once.
  return '';
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
    return `🎯 <u>AAAAAAACE!</u>\n\n${desc}${link}`;
  },

  peak_rank_up: (payload, user, _match) => {
    const to = payload['to_tier_name'] ?? '';
    const rankEmoji = rankToEmojiHtml(to as string);
    let rankPart = '';
    if (to) {
      rankPart = rankEmoji ? ` ${rankEmoji} ${esc(String(to))}` : ` ${esc(String(to))}`;
    }
    const desc = `${playerTag(user)} — поднялся(лась) до${rankPart}`;
    return `🎖 <u>Повышение по службе</u>\n${desc}`;
  },

  winstreak_10plus: (payload, user, _match) => {
    const streak = payload['streak'] ?? 10;
    const desc = `${playerTag(user)} — ${esc(String(streak))} побед подряд`;
    return `🏆 <u>Винстрик недели:</u>\n${desc}`;
  },

  giant_slayer: (payload, user, match) => {
    const own = payload['own'] ?? '';
    const enemy = payload['enemy_avg'] ?? '';
    const ownStr = own ? ` (${esc(String(own))})` : '';
    const enemyStr = enemy ? ` (средний ранг ${esc(String(enemy))})` : '';
    const desc = `${playerTag(user)}${ownStr} — выиграл(а) против превосходящего врага${enemyStr}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `💪 <u>Поводил(ла) по губам</u>\n\n${desc}${link}`;
  },

  return_after_pause: (payload, user, _match) => {
    const days = payload['days_paused'] ?? '?';
    const desc = `${playerTag(user)} — после ${esc(String(days))} дней паузы снова в строю`;
    return `👋 <u>С возвращением</u>\n\n${desc}`;
  },

  teamkill: (payload, user, match) => {
    const roundNumbers = Array.isArray(payload['round_numbers']) ? payload['round_numbers'] : [];
    const count = roundNumbers.length > 1 ? ` (${roundNumbers.length}× за матч)` : '';
    const victimNames = Array.isArray(payload['victim_names_for_template']) ? payload['victim_names_for_template'] as string[] : [];
    const uniqueVictims = Array.from(new Set(victimNames.filter((n) => n && n.length > 0)));
    const victimStr = uniqueVictims.length > 0 ? ` (${uniqueVictims.map((n) => `<b>${esc(n)}</b>`).join(', ')})` : '';
    const desc = `${playerTag(user)} убил(а) своего${victimStr}${count}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🐀 <u>Ля ты и крыса</u>\n\n${desc}${link}`;
  },

  fall_damage_death: (payload, user, match) => {
    const n = Number(payload['count'] ?? 1);
    const countStr = n > 1 ? ` (${n}×)` : '';
    const desc = `${playerTag(user)} — умер(ла) от падения${countStr}${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🪂 <u>1:0 в пользу гравитации</u>\n\n${desc}${link}`;
  },

  record_damage_dealt_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_damage_dealt_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} dmg${matchLinkInline(match?.match_id)}`;
    return `🥩 <u>Мясник</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_damage_received_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_damage_received_match');
    const valueLine = `${playerTag(user)} — получил(а) ${esc(String(value))} dmg${matchLinkInline(match?.match_id)}`;
    return `🤕 <u>Груша для битья</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_kills_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_kills_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} фрагов${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `💀 <u>Серийный маньяк</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_deaths_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_deaths_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} смертей${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `⚰️ <u>Магнит для пуль</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_headshots_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_headshots_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} попаданий в голову${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `🤠 <u>Директор дикого запада</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_legshots_match: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_legshots_match');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} попаданий в ноги${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `♿️ <u>Угадай куда шмальну</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_survived_last_rounds: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_survived_last_rounds');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} последних смертей${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `⚓ <u>Якорь</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  record_died_first_rounds: (payload, user, match) => {
    const value = payload['value'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = recordContextLine('record_died_first_rounds');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} первых смертей${matchLinkInline(match?.match_id ? String(match.match_id) : undefined)}`;
    return `🐴 <u>Троянский конь</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

  knife_kill: (payload, user, match) => {
    const count = Number(payload['count'] ?? 1);
    const countStr = count > 1 ? `${count} врагов` : 'врага';
    const desc = `${playerTag(user)} — зарезал(а) ${countStr} с ножа${mapSuffix(match?.map)}`;
    const link = match?.match_id ? matchLine(match.match_id) : '';
    return `🔪 <u>Заколол баранчика</u>\n\n${desc}${link}`;
  },

  record_mvp_count_week: (payload, user, _match) => {
    const value = payload['value'];
    const prevValue = payload['prev_value'];
    // Treat 0 prev_value as "no prev record" (legacy behaviour)
    const prevForLine = (prevValue !== null && prevValue !== undefined && Number(prevValue) > 0) ? prevValue : undefined;
    const prev = prevRecordLine(prevForLine, payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid, 'MVP');
    const ctx = recordContextLine('record_mvp_count_week');
    const valueLine = `${playerTag(user)} — ${esc(String(value))} MVP-матчей`;
    return `👑 <u>Король MVP за неделю</u>\n${ctxLine(ctx!)}\n${valueLine}${prev}`;
  },

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
      ? payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>
      : [];
    const playerLines = players
      .map((p) => p.name ? `🏅<b>${esc(p.name)}#${esc(p.tag ?? '')}</b>` : '')
      .filter((s) => s);
    const playersBlock = playerLines.length > 0
      ? playerLines.join('\n')
      : `🏅${playerTag(user)}`;
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

  record_kills_per_weapon: (payload, user, _match) => {
    const weapon = payload['weapon'] ?? '?';
    const value = payload['value'];
    const realMatchId = payload['real_match_id'];
    const prev = prevRecordLine(payload['prev_value'], payload['prev_name'], payload['prev_tag'], payload['prev_puuid'], user.riot_puuid);
    const ctx = 'самое большое количество убийств за игру из одного оружия';
    const valueLine = `${playerTag(user)} — ${esc(String(value))} фрагов${matchLinkInline(realMatchId ? String(realMatchId) : undefined)}`;
    return `${weaponLead(String(weapon), '🔫')} <u>Эксперт по ${esc(String(weapon))}</u>\n${ctxLine(ctx)}\n${valueLine}${prev}`;
  },

  record_longest_match_minutes: (payload, user, match) => {
    const minutes = payload['value'];
    const rounds = payload['rounds'];
    const result = String(payload['result'] ?? '');
    const resultEmoji = result === 'win' ? '🏆' : result === 'loss' ? '💀' : result === 'draw' ? '🏳️' : '';
    const players = Array.isArray(payload['community_players'])
      ? payload['community_players'] as Array<{ puuid: string; name: string; tag: string }>
      : [];
    const playersLine = players
      .map((p) => p.name ? `<b>${esc(p.name)}#${esc(p.tag ?? '')}</b>` : '')
      .filter((s) => s)
      .join(', ');
    const ctx = 'рекорд по длительности матча';
    const roundsPart = rounds ? ` (${esc(String(rounds))} раундов)` : '';
    const resultPart = resultEmoji ? ` ${resultEmoji}` : '';
    // Per user: nick first, then the data line — single line.
    // Fallback to playerTag(user) when there are no community_players in payload.
    const lead = playersLine || playerTag(user);
    const valueLine = `${lead} - ${esc(String(minutes))} минут${roundsPart}${mapSuffix(match?.map)}${resultPart}${matchLinkInline(match?.match_id)}`;
    return `⏳ <u>Дело принципа</u>\n${ctxLine(ctx)}\n${valueLine}`;
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
    return `⚔️ <u>Френдлифаер</u>\n\n${desc}${link}`;
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
 * (winstreak_10plus, peak_rank_up) when ≥2 entries of the
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
    return `🏆 <u>Винстрик недели:</u>\n${lines.join('\n')}`;
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
    return `🎖 <u>${header}</u>\n${lines.join('\n')}`;
  }

  if (eventType === 'record_kills_per_weapon') {
    // Combined section: one block listing all weapon records of the week.
    // Per user line format: `Weapon - N | <b>nick#tag</b>`. No match link, no
    // prev record. Sorted desc by frag count.
    const lines = entries
      .map((e) => {
        const weapon = String(e.payload['weapon'] ?? '?');
        const value = Number(e.payload['value'] ?? 0);
        return { weapon, value, user: e.user };
      })
      .sort((a, b) => b.value - a.value)
      .map((x) => `${weaponLead(x.weapon, '🎯')} ${esc(x.weapon)} ${x.value} - <b>${esc(x.user.riot_name)}#${esc(x.user.riot_tag)}</b>`);
    return `🔫 <u>Мастера своего дела</u>\n${ctxLine('лидеры по убийствам одним оружием за матч')}\n${lines.join('\n')}`;
  }

  // Fallback: not group-capable but called anyway — render each event individually.
  return entries.map((e) => renderTemplate(eventType, e.payload, e.user, e.match)).join('\n\n');
}
