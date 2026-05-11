/**
 * build.ts — Pure aggregator for weekly digest content.
 *
 * Queries DB over a rolling 7-day window and renders sections in block layout:
 *
 * BRIGHT EVENTS (top block — omitted if none):
 *   record_kills_match, winstreak_10plus, giant_slayer, ace_rare_weapon_week,
 *   ace, rank_promo
 * Divider ━━━━━━━━━━━━━━
 *
 * ALWAYS-SECTIONS (bottom block):
 *   Pulse → Top Player → Top Maps → Top Agents
 *
 * Last line: #digest
 *
 * Anti-coercion: NEVER mentions who didn't play, who opted out, or
 * includes "play more / come back" calls (memory rule: valorant_no_qol_coercion).
 */

import { and, gte, lt, sql, eq } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { computeAndEmitWeeklyMvpRecord } from './weekly-mvp-record.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/**
 * HTML-escape a string to prevent injection in Telegram HTML messages.
 * Intentional duplication of the same helper in publisher/templates.ts —
 * avoids touching templates.ts and risking merge conflicts; can be DRY'd later.
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
 * Bright event types rendered in the top block of the digest.
 * Ordered by display priority (highest weight first for sort).
 */
const BRIGHT_EVENT_WEIGHTS: Record<string, number> = {
  ace_rare_weapon_week: 10,
  ace: 8,
  record_kills_match: 7,
  record_damage_dealt_match: 7,
  record_damage_received_match: 7,
  record_mvp_count_week: 7,
  record_kills_per_weapon: 7,
  giant_slayer: 6,
  winstreak_10plus: 4,
  rank_promo: 3,
};

function isBrightEvent(eventType: string): boolean {
  return eventType in BRIGHT_EVENT_WEIGHTS;
}

function getBrightEventWeight(eventType: string): number {
  return BRIGHT_EVENT_WEIGHTS[eventType] ?? 0;
}

/**
 * Render a 2–4 line block for a bright event, suitable for the top section of the digest.
 * Returns null if event type is not a recognized bright event.
 */
function renderBrightBlock(
  eventType: string,
  payload: Record<string, unknown>,
  user: { riot_name: string; riot_tag: string },
  map?: string,
): string | null {
  const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
  const mapStr = map ? ` на ${esc(map)}` : '';

  switch (eventType) {
    case 'ace_rare_weapon_week': {
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
      return `💎 ${name} знает толк в извращениях. Эйс — <b>${esc(weaponStr)}</b>${mapStr}`;
    }
    case 'ace': {
      const rounds = Array.isArray(payload['rounds']) ? payload['rounds'] : [];
      const rStr = rounds.length > 1 ? ` (${rounds.length}×)` : '';
      return `🎯 Эйс${rStr} — ${name}${mapStr}`;
    }
    case 'giant_slayer': {
      const enemyAvg = payload['enemy_avg'] ? ` рангом ${esc(String(payload['enemy_avg']))}` : '';
      const own = payload['own'] ? ` (ранг: ${esc(String(payload['own']))})` : '';
      return `⚔️ Гигантоборец — ${name} взял команду${enemyAvg}${own}`;
    }
    case 'rank_promo': {
      const from = payload['from'] ? esc(String(payload['from'])) : null;
      const to = payload['to'] ? esc(String(payload['to'])) : null;
      if (from && to) {
        return `📈 Повышение по службе — ${name} (${from} → ${to})`;
      }
      if (to) {
        return `📈 Повышение по службе — ${name} (→ ${to})`;
      }
      return `📈 Повышение по службе — ${name}`;
    }
    case 'winstreak_10plus': {
      const streak = payload['streak'] ?? 10;
      return `🔥 Серия побед — ${esc(String(streak))} подряд у ${name}`;
    }
    case 'record_kills_match': {
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const matchLink = payload['match_id']
        ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(payload['match_id']))}">→ матч</a>`
        : '';
      let prevLine = '';
      if (prevValue !== null && prevValue !== undefined) {
        prevLine = `\nпрошлый рекорд: ${esc(String(prevValue))}`;
      }
      return `🔪 <b>Мирного рішення не буде</b>\n${name} — ${esc(String(value))} фрагов${mapStr}${prevLine}${matchLink}`;
    }
    case 'record_damage_dealt_match': {
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const prevName = payload['prev_name'];
      const prevTag = payload['prev_tag'];
      const prevPuuid = payload['prev_puuid'];
      const matchLink = payload['match_id']
        ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(payload['match_id']))}">→ матч</a>`
        : '';
      let prevStr = '';
      if (prevValue !== null && prevValue !== undefined) {
        if (prevName) {
          prevStr = ` (прошлый: ${esc(String(prevValue))}, у <b>${esc(String(prevName))}${prevTag ? '#' + esc(String(prevTag)) : ''}</b>)`;
        } else if (prevPuuid) {
          prevStr = ` (прошлый: ${esc(String(prevValue))})`;
        } else {
          prevStr = ` (прошлый: ${esc(String(prevValue))})`;
        }
      }
      return `🥩 <b>Мясник недели:</b> ${name} — ${esc(String(value))} dmg${prevStr}${matchLink}`;
    }
    case 'record_damage_received_match': {
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const prevName = payload['prev_name'];
      const prevTag = payload['prev_tag'];
      const matchLink = payload['match_id']
        ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(payload['match_id']))}">→ матч</a>`
        : '';
      let prevStr = '';
      if (prevValue !== null && prevValue !== undefined) {
        if (prevName) {
          prevStr = ` (прошлый: ${esc(String(prevValue))}, у <b>${esc(String(prevName))}${prevTag ? '#' + esc(String(prevTag)) : ''}</b>)`;
        } else {
          prevStr = ` (прошлый: ${esc(String(prevValue))})`;
        }
      }
      return `😵 <b>Надругались над</b> ${name} — получил ${esc(String(value))} dmg за матч${prevStr}${matchLink}`;
    }
    case 'record_mvp_count_week': {
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const prevName = payload['prev_name'];
      const prevTag = payload['prev_tag'];
      let prevLine = '';
      if (prevValue !== null && prevValue !== undefined && Number(prevValue) > 0) {
        if (prevName) {
          prevLine = `\nпрошлый рекорд: ${esc(String(prevValue))} у <b>${esc(String(prevName))}${prevTag ? '#' + esc(String(prevTag)) : ''}</b>`;
        } else {
          prevLine = `\nпрошлый рекорд: ${esc(String(prevValue))}`;
        }
      }
      return `🏅 <b>${name} отказался от личной жизни</b> и взял ${esc(String(value))} MVP-матчей за неделю${prevLine}`;
    }
    case 'record_kills_per_weapon': {
      const weapon = payload['weapon'] ?? '?';
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const prevName = payload['prev_name'];
      const prevTag = payload['prev_tag'];
      // real_match_id is kept in payload; ev.match_id is synthetic (match_id#kpw-WEAPON)
      const realMatchId = payload['real_match_id'];
      const matchLink = realMatchId
        ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(realMatchId))}">→ матч</a>`
        : '';
      let prevStr = '';
      if (prevValue !== null && prevValue !== undefined) {
        if (prevName) {
          prevStr = ` (прошлый: ${esc(String(prevValue))}, у <b>${esc(String(prevName))}${prevTag ? '#' + esc(String(prevTag)) : ''}</b>)`;
        } else {
          prevStr = ` (прошлый: ${esc(String(prevValue))})`;
        }
      }
      return `🔫 <b>Рекорд из ${esc(String(weapon))}:</b> ${name} — ${esc(String(value))} фрагов${mapStr}${prevStr}${matchLink}`;
    }
    default:
      return null;
  }
}

export interface BuildDigestDeps {
  db: AnyDb;
  /** Window start in ms (inclusive). */
  weekStart: number;
  /** Window end in ms (exclusive). */
  weekEnd: number;
}

export interface BuildDigestResult {
  /** Null when no sections produce content — don't post. */
  text: string | null;
  sectionsIncluded: string[];
}

/**
 * Build the weekly digest text.
 *
 * Returns `{ text: null }` when no matches exist in the window (completely empty week).
 * When matches > 0, always returns a non-null text (pulse + bottom sections + #digest).
 */
export async function buildDigest(deps: BuildDigestDeps): Promise<BuildDigestResult> {
  const { db, weekStart, weekEnd } = deps;

  const sectionsIncluded: string[] = [];

  // ─── Weekly MVP record detector (digest-tick, runs before bright events query) ─
  {
    // Derive weekIso from weekEnd using the same Thursday-anchor algorithm as loop.ts
    const weekIso = computeWeekIso(weekEnd);
    await computeAndEmitWeeklyMvpRecord(db, weekStart, weekEnd, weekIso);
  }

  // ─── Opt-out helpers ────────────────────────────────────────────────────────

  /** Fetch set of opted-out telegram_ids. */
  async function getOptOutSet(): Promise<Set<number>> {
    const rows = await db
      .select({ telegram_id: optOuts.telegram_id })
      .from(optOuts)
      .where(eq(optOuts.chat_realtime_disabled, 1));
    return new Set(rows.map((r: { telegram_id: number }) => r.telegram_id));
  }

  /** Fetch a user by riot_puuid. Returns null if not found. */
  async function getUserByPuuid(puuid: string): Promise<{ riot_name: string; riot_tag: string; telegram_id: number } | null> {
    const [row] = await db
      .select({ riot_name: users.riot_name, riot_tag: users.riot_tag, telegram_id: users.telegram_id })
      .from(users)
      .where(eq(users.riot_puuid, puuid))
      .limit(1);
    return row ?? null;
  }

  // ─── Check if any matches exist in window ───────────────────────────────────
  const [totalRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(matchRecords)
    .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)));

  const totalMatches = Number(totalRow?.count ?? 0);

  if (totalMatches === 0) {
    return { text: null, sectionsIncluded: [] };
  }

  // ─── Header ─────────────────────────────────────────────────────────────────
  const headerDate = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(weekEnd);
  const header = `📅 <b>Дайджест за неделю · ${headerDate}</b>`;

  // ─── BRIGHT EVENTS (top block) ───────────────────────────────────────────────
  const brightBlocks: string[] = [];

  {
    const optedOut = await getOptOutSet();

    // Fetch all bright event types in window
    const events = await db
      .select({
        id: detectedEvents.id,
        event_type: detectedEvents.event_type,
        riot_puuid: detectedEvents.riot_puuid,
        match_id: detectedEvents.match_id,
        payload_json: detectedEvents.payload_json,
        detected_at: detectedEvents.detected_at,
      })
      .from(detectedEvents)
      .where(
        and(
          gte(detectedEvents.detected_at, weekStart),
          lt(detectedEvents.detected_at, weekEnd),
        ),
      )
      .orderBy(detectedEvents.detected_at);

    // Filter to bright events only
    const brightEvents = events.filter((ev: { event_type: string }) => isBrightEvent(ev.event_type as string));

    // Sort: by weight desc, then detected_at asc (already sorted by detected_at)
    const sorted = [...brightEvents].sort((a: { event_type: string; detected_at: number }, b: { event_type: string; detected_at: number }) => {
      const wa = getBrightEventWeight(a.event_type as string);
      const wb = getBrightEventWeight(b.event_type as string);
      if (wb !== wa) return wb - wa;
      return Number(a.detected_at) - Number(b.detected_at);
    });

    for (const ev of sorted) {
      const puuid = ev.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;

      // rank_promo renders even for opted-out players (positive progress)
      // Other bright events: skip opted-out players
      if (ev.event_type !== 'rank_promo' && optedOut.has(user.telegram_id)) continue;

      const payload = safeParseJson(ev.payload_json as string);

      // record_kills_per_weapon uses a synthetic match_id (match_id#kpw-WEAPON) for dedup.
      // The real match_id is stored in payload.real_match_id.
      const realMatchId: string =
        ev.event_type === 'record_kills_per_weapon'
          ? String(payload['real_match_id'] ?? '')
          : String(ev.match_id ?? '');

      // Fetch map from match_records
      const [matchRow] = realMatchId
        ? await db
            .select({ map: matchRecords.map })
            .from(matchRecords)
            .where(
              and(
                eq(matchRecords.match_id, realMatchId),
                eq(matchRecords.riot_puuid, puuid),
              ),
            )
            .limit(1)
        : [undefined];

      const map: string | undefined = matchRow?.map ?? undefined;

      // For record types, attach match_id to payload for link
      if (
        (ev.event_type === 'record_kills_match' ||
          ev.event_type === 'record_damage_dealt_match' ||
          ev.event_type === 'record_damage_received_match') &&
        ev.match_id
      ) {
        payload['match_id'] = ev.match_id;
      }
      // record_kills_per_weapon: real_match_id already present in payload; no injection needed

      const block = renderBrightBlock(ev.event_type as string, payload, user, map);
      if (block) {
        brightBlocks.push(block);
        sectionsIncluded.push(ev.event_type as string);
      }
    }
  }

  // ─── ALWAYS-SECTIONS ─────────────────────────────────────────────────────────
  const alwaysSections: string[] = [];

  // Pulse (simplified)
  {
    alwaysSections.push(`📊 За неделю мы сыграли ${totalMatches} матчей`);
    sectionsIncluded.push('pulse');
  }

  // Top Player (Most Active) — top by match count, ≥5 matches
  {
    const optedOut = await getOptOutSet();

    const candidates = await db
      .select({
        riot_puuid: matchRecords.riot_puuid,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.riot_puuid)
      .orderBy(sql`COUNT(*) DESC`);

    for (const row of candidates) {
      const puuid = row.riot_puuid as string;
      const cnt = Number(row.cnt);
      if (cnt < 5) break;

      const user = await getUserByPuuid(puuid);
      if (!user) continue;
      if (optedOut.has(user.telegram_id)) continue;

      const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
      alwaysSections.push(`🏆 Больше всех матчей — ${name} (${cnt} за неделю)`);
      sectionsIncluded.push('mostActive');
      break;
    }
  }

  // Top Maps — top 3 maps by match count
  {
    const maps = await db
      .select({
        map: matchRecords.map,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.map)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(3);

    if (maps.length > 0) {
      const mapStr = maps
        .map((m: { map: string; cnt: number }) => `<b>${esc(String(m.map))}</b> (${Number(m.cnt)}×)`)
        .join(', ');
      alwaysSections.push(`🗺 Чаще всего играли на: ${mapStr}`);
      sectionsIncluded.push('topMaps');
    }
  }

  // Top Agents — top 3 by pick count
  {
    const agents = await db
      .select({
        agent: matchRecords.agent,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.agent)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(3);

    if (agents.length > 0) {
      const agentStr = agents
        .map((a: { agent: string; cnt: number }) => `<b>${esc(String(a.agent))}</b> (${Number(a.cnt)}×)`)
        .join(', ');
      alwaysSections.push(`🎭 Чаще всего пикали: ${agentStr}`);
      sectionsIncluded.push('topAgents');
    }
  }

  // ─── Compose ─────────────────────────────────────────────────────────────────
  const parts: string[] = [header];

  if (brightBlocks.length > 0) {
    parts.push('');
    parts.push(brightBlocks.join('\n\n'));
    parts.push('');
    parts.push('━━━━━━━━━━━━━━');
  }

  parts.push('');
  parts.push(alwaysSections.join('\n'));
  parts.push('');
  parts.push('#digest');

  const text = parts.join('\n');
  return { text, sectionsIncluded };
}

/**
 * Compute ISO week string (e.g. "2026-W19") for the given timestamp,
 * using the same Thursday-anchor algorithm as loop.ts getDigestNowKyiv().
 */
function computeWeekIso(ms: number): string {
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmtDate.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const fmtWeekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    weekday: 'short',
  });
  const weekdayStr = fmtWeekday.format(ms);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[weekdayStr] ?? 0;

  const todayMidnightMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayMs = todayMidnightMs - daysFromMonday * 86400000;

  const thursdayMs = mondayMs + 3 * 86400000;
  const thursdayDate = new Date(thursdayMs);
  const thurYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(thurYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay();
  const jan4Monday = jan4 - (jan4Weekday === 0 ? 6 : jan4Weekday - 1) * 86400000;
  const weekNumber = Math.floor((thursdayMs - jan4Monday) / (7 * 86400000)) + 1;
  return `${thurYear}-W${String(weekNumber).padStart(2, '0')}`;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
