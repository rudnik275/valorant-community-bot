/**
 * build.ts — Pure aggregator for weekly digest content.
 *
 * Queries DB over a 7-day window and renders sections:
 * 1. Pulse — total_matches, unique_players, avg_per_player
 * 2. Epic Moment — top detected_event by weight (opt-out: skip to next)
 * 3. Rank Progress — rank_promo events (opt-out ignored: positive progress)
 * 4. Most Active — top player by match count (opt-out: skip to next)
 * 5. Top Agents — top 3 by pick count
 * 6. Best K/D One Match — gate ≥10 rounds (opt-out: skip to next)
 *
 * Anti-coercion: NEVER mentions who didn't play, who opted out, or
 * includes "play more / come back" calls (memory rule: valorant_no_qol_coercion).
 */

import { and, gte, lt, sql, eq } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
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

/** Event weights for digest "epic moment" selection. */
const EVENT_WEIGHTS: Record<string, number> = {
  ace_rare_weapon: 10,
  ace: 8,
  record_kills_match: 7,
  giant_slayer: 6,
  return_after_pause: 5,
  rank_promo: 5,
  winstreak_9: 4,
};

function getEventWeight(eventType: string): number {
  return EVENT_WEIGHTS[eventType] ?? 0;
}

/**
 * Render a one-line description of the epic moment for digest use.
 */
function renderDigestEpicLine(
  eventType: string,
  payload: Record<string, unknown>,
  user: { riot_name: string; riot_tag: string },
  map?: string,
): string {
  const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
  const mapStr = map ? ` на ${esc(map)}` : '';

  switch (eventType) {
    case 'ace_rare_weapon': {
      const weapons = Array.isArray(payload['weapons']) ? payload['weapons'] : [];
      const wStr = weapons.length > 0 ? ` (${weapons.map((w) => esc(String(w))).join(', ')})` : '';
      return `🌟 Самый яркий момент недели — эйс редким оружием${wStr} от ${name}${mapStr}`;
    }
    case 'ace': {
      const rounds = Array.isArray(payload['rounds']) ? payload['rounds'] : [];
      const rStr = rounds.length > 1 ? ` (${rounds.length}×)` : '';
      return `🌟 Самый яркий момент недели — эйс${rStr} от ${name}${mapStr}`;
    }
    case 'giant_slayer': {
      return `🌟 Самый яркий момент недели — гигантоборец ${name}${mapStr}`;
    }
    case 'return_after_pause': {
      return `🌟 Самый яркий момент недели — возвращение ${name}`;
    }
    case 'rank_promo': {
      const from = payload['from'] ? esc(String(payload['from'])) : null;
      const to = payload['to'] ? esc(String(payload['to'])) : null;
      if (from && to) {
        return `🌟 Самый яркий момент недели — апгрейд ранга у ${name} (${from} → ${to})`;
      }
      return `🌟 Самый яркий момент недели — апгрейд ранга у ${name}`;
    }
    case 'winstreak_9': {
      const streak = payload['streak'] ?? 9;
      return `🌟 Самый яркий момент недели — ${esc(String(streak))} побед подряд у ${name}`;
    }
    default:
      return `🌟 Самый яркий момент недели — событие у ${name}${mapStr}`;
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
 * Returns `{ text: null }` when no sections produce content (empty window or
 * all users opted out from individual sections).
 */
export async function buildDigest(deps: BuildDigestDeps): Promise<BuildDigestResult> {
  const { db, weekStart, weekEnd } = deps;

  const sectionsIncluded: string[] = [];
  const sectionTexts: string[] = [];

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

  // ─── Section 1: Pulse ───────────────────────────────────────────────────────
  {
    const [totalRow] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)));

    const [uniqueRow] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${matchRecords.riot_puuid})` })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)));

    const totalMatches = Number(totalRow?.count ?? 0);
    const uniquePlayers = Number(uniqueRow?.count ?? 0);

    if (totalMatches > 0) {
      const avgPerPlayer = uniquePlayers > 0
        ? Math.round(totalMatches / uniquePlayers)
        : 0;
      sectionTexts.push(
        `📊 За неделю мы сыграли ${totalMatches} матчей, в среднем ${avgPerPlayer} матчей на игрока`,
      );
      sectionsIncluded.push('pulse');
    }
  }

  // ─── Section 2: Epic Moment ──────────────────────────────────────────────────
  {
    // Fetch all detected events in window, ordered by detected_at (for tie-breaking)
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

    // Sort by weight desc, then detected_at asc (already ordered by detected_at)
    const sorted = [...events].sort((a, b) => {
      const wa = getEventWeight(a.event_type as string);
      const wb = getEventWeight(b.event_type as string);
      if (wb !== wa) return wb - wa;
      return Number(a.detected_at) - Number(b.detected_at);
    });

    const optedOut = await getOptOutSet();

    // Find first top event whose owner is NOT opted out
    for (const ev of sorted) {
      const puuid = ev.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;
      if (optedOut.has(user.telegram_id)) continue;

      // Found a non-opted-out event
      const payload = safeParseJson(ev.payload_json as string);

      // Fetch map from match_records
      const [matchRow] = await db
        .select({ map: matchRecords.map })
        .from(matchRecords)
        .where(
          and(
            eq(matchRecords.match_id, ev.match_id as string),
            eq(matchRecords.riot_puuid, puuid),
          ),
        )
        .limit(1);

      const map: string | undefined = matchRow?.map ?? undefined;

      const line = renderDigestEpicLine(ev.event_type as string, payload, user, map);
      sectionTexts.push(line);
      sectionsIncluded.push('epicMoment');
      break;
    }
  }

  // ─── Section 3: Rank Progress ────────────────────────────────────────────────
  {
    // Opt-out does NOT apply (positive individual progress)
    const rankEvents = await db
      .select({
        riot_puuid: detectedEvents.riot_puuid,
        payload_json: detectedEvents.payload_json,
      })
      .from(detectedEvents)
      .where(
        and(
          gte(detectedEvents.detected_at, weekStart),
          lt(detectedEvents.detected_at, weekEnd),
          eq(detectedEvents.event_type, 'rank_promo'),
        ),
      )
      .orderBy(detectedEvents.detected_at);

    const promotions: string[] = [];
    for (const ev of rankEvents) {
      const puuid = ev.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;

      const payload = safeParseJson(ev.payload_json as string);
      const from = payload['from'] ? String(payload['from']) : null;
      const to = payload['to'] ? String(payload['to']) : null;

      const name = `${user.riot_name}#${user.riot_tag}`;
      if (from && to) {
        promotions.push(`${esc(name)} (${esc(from)} → ${esc(to)})`);
      } else if (to) {
        promotions.push(`${esc(name)} (→ ${esc(to)})`);
      } else {
        promotions.push(esc(name));
      }
    }

    if (promotions.length > 0) {
      sectionTexts.push(`📈 На этой неделе ранг апнули: ${promotions.join(', ')}`);
      sectionsIncluded.push('rankProgress');
    }
  }

  // ─── Section 4: Most Active ──────────────────────────────────────────────────
  {
    const optedOut = await getOptOutSet();

    // Fetch top players by match count (up to optedOut.size + 1 candidates)
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
      if (cnt < 5) break; // all remaining also < 5

      const user = await getUserByPuuid(puuid);
      if (!user) continue;
      if (optedOut.has(user.telegram_id)) continue;

      const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
      sectionTexts.push(`🏆 Больше всех матчей сыграл ${name} (${cnt} за неделю)`);
      sectionsIncluded.push('mostActive');
      break;
    }
  }

  // ─── Section 5: Top Agents ───────────────────────────────────────────────────
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
        .map((a: { agent: string; cnt: number }) => `${esc(String(a.agent))} (${Number(a.cnt)}×)`)
        .join(', ');
      sectionTexts.push(`🎭 На этой неделе чаще всего пикали: ${agentStr}`);
      sectionsIncluded.push('topAgents');
    }
  }

  // ─── Section 6: Best K/D One Match ──────────────────────────────────────────
  {
    const optedOut = await getOptOutSet();

    // Fetch candidates ordered by k/d ratio desc, gate ≥10 rounds
    const candidates = await db
      .select({
        riot_puuid: matchRecords.riot_puuid,
        kills: matchRecords.kills,
        deaths: matchRecords.deaths,
        map: matchRecords.map,
        rounds_played: matchRecords.rounds_played,
        kd_ratio: sql<number>`(${matchRecords.kills} * 1.0 / MAX(${matchRecords.deaths}, 1))`,
      })
      .from(matchRecords)
      .where(
        and(
          gte(matchRecords.started_at, weekStart),
          lt(matchRecords.started_at, weekEnd),
          gte(matchRecords.rounds_played, 10),
        ),
      )
      .orderBy(sql`(${matchRecords.kills} * 1.0 / MAX(${matchRecords.deaths}, 1)) DESC`);

    for (const row of candidates) {
      const puuid = row.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;
      if (optedOut.has(user.telegram_id)) continue;

      const kills = Number(row.kills);
      const deaths = Number(row.deaths);
      const map = row.map as string;

      const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
      sectionTexts.push(`⚖️ Самый ровный матч недели — у ${name}: ${kills}/${deaths} на ${esc(map)}`);
      sectionsIncluded.push('bestKDMatch');
      break;
    }
  }

  // ─── Section 7: All-Time Records (kills/match) ──────────────────────────────
  {
    const recordEvents = await db
      .select({
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
          eq(detectedEvents.event_type, 'record_kills_match'),
        ),
      )
      .orderBy(detectedEvents.detected_at);

    for (const ev of recordEvents) {
      const puuid = ev.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;

      const payload = safeParseJson(ev.payload_json as string);
      const value = payload['value'];
      const prevValue = payload['prev_value'];
      const prevPuuid = payload['prev_puuid'];

      const [matchRow] = await db
        .select({ map: matchRecords.map })
        .from(matchRecords)
        .where(
          and(
            eq(matchRecords.match_id, ev.match_id as string),
            eq(matchRecords.riot_puuid, puuid),
          ),
        )
        .limit(1);

      const map: string | undefined = matchRow?.map ?? undefined;
      const mapStr = map ? ` на ${esc(map)}` : '';

      const name = `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>`;
      const samePlayer = prevPuuid === puuid;

      let prevLine = '';
      if (prevValue !== null && prevValue !== undefined) {
        if (samePlayer) {
          prevLine = `\nпрошлый: ${esc(String(prevValue))} у него же`;
        } else if (prevPuuid) {
          const prevUser = await getUserByPuuid(prevPuuid as string);
          const prevName = prevUser
            ? `<b>${esc(prevUser.riot_name)}#${esc(prevUser.riot_tag)}</b>`
            : esc(String(prevPuuid));
          prevLine = `\nпрошлый: ${esc(String(prevValue))} у ${prevName}`;
        } else {
          prevLine = `\nпрошлый: ${esc(String(prevValue))}`;
        }
      }

      const matchLink = ev.match_id
        ? ` · <a href="https://tracker.gg/valorant/match/${esc(String(ev.match_id))}">→ матч</a>`
        : '';

      sectionTexts.push(
        `🔪 <b>Мирного рішення не буде</b>\n${name} — ${esc(String(value))} фрагов${mapStr}${prevLine}${matchLink}`,
      );
      sectionsIncluded.push('recordKillsMatch');
      // Only show the latest record in the window (loop breaks after first)
      break;
    }
  }

  // ─── Compose ─────────────────────────────────────────────────────────────────
  if (sectionTexts.length === 0) {
    return { text: null, sectionsIncluded: [] };
  }

  const text = `📅 <b>Дайджест недели</b>\n\n${sectionTexts.join('\n\n')}`;
  return { text, sectionsIncluded };
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
