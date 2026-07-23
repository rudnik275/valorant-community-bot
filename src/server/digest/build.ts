/**
 * build.ts — Pure aggregator for weekly digest content.
 *
 * Queries DB over a rolling 7-day window and renders sections in block layout:
 *
 * BRIGHT EVENTS (top block — omitted if none):
 *   record_*_match, winstreak_10plus, peak_rank_up,
 *   record_kills_per_weapon (combined section), record_longest_match_minutes,
 *   record_mvp_count_week, plus near-miss blocks (merged into the same group).
 *
 * ALWAYS-SECTIONS (bottom block, no divider):
 *   Pulse → Top Player → Top Maps → Top Agents
 *
 * Last line: #digest
 *
 * Anti-coercion: NEVER mentions who didn't play, who opted out, or
 * includes "play more / come back" calls (memory rule: valorant_no_qol_coercion).
 */

import { and, gte, lt, sql, eq, desc, isNotNull } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { allTimeRecords } from '../db/schema/all_time_records.ts';
import { computeAndEmitWeeklyMvpRecord } from './weekly-mvp-record.ts';
import { NEAR_MISS_THRESHOLDS } from './near-miss-config.ts';
import { renderTemplate, renderDigestGroup, type TemplateUser, type TemplateMatch } from '../publisher/templates.ts';
import { renderPlayerName } from '../publisher/player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml, weaponToEmojiHtml } from '../publisher/valorant-emoji.ts';
import type { EventType } from '../publisher/types.ts';
import {
  renderRichDigest,
  type RichDigestModel,
  type RichWeaponMaster,
  type RichRecord,
  type RichWinstreak,
  type RichPromotion,
  type RichNearMiss,
} from './rich-render.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/**
 * Per-record-type metadata for the rich `<details>` accordions (#315).
 * `emoji` + `title` mirror the header of each record template in
 * publisher/templates.ts; `context` is the verbatim context-description line;
 * `value(payload)` formats the value line WITHOUT the nick/link (those come
 * from the shared helpers). Kept in sync with templates.ts by construction —
 * the legacy text still renders through templates.ts, so these two only both
 * change when the record's user-visible copy changes.
 */
const RICH_RECORD_META: Record<
  string,
  { emoji: string; title: string; context: string; value: (payload: Record<string, unknown>) => string }
> = {
  record_kills_match: {
    emoji: '💀',
    title: 'Серийный маньяк',
    context: 'рекорд по количеству фрагов за игру',
    value: (p) => `${p['value']} фрагов`,
  },
  record_deaths_match: {
    emoji: '⚰️',
    title: 'Магнит для пуль',
    context: 'рекорд по количеству смертей за игру',
    value: (p) => `${p['value']} смертей`,
  },
  record_headshots_match: {
    emoji: '🤠',
    title: 'Директор дикого запада',
    context: 'рекорд по количеству попаданий в голову за игру (не убийств)',
    value: (p) => `${p['value']} попаданий в голову`,
  },
  record_legshots_match: {
    emoji: '♿️',
    title: 'Угадай куда шмальну',
    context: 'рекорд по количеству попаданий в ноги за игру (не убийств)',
    value: (p) => `${p['value']} попаданий в ноги`,
  },
  record_damage_dealt_match: {
    emoji: '🥩',
    title: 'Мясник',
    context: 'рекорд по нанесённому урону за игру',
    value: (p) => `${p['value']} dmg`,
  },
  record_damage_received_match: {
    emoji: '🤕',
    title: 'Груша для битья',
    context: 'рекорд по полученному урону за игру',
    value: (p) => `получил(а) ${p['value']} dmg`,
  },
  record_mvp_count_week: {
    emoji: '👑',
    title: 'Король MVP за неделю',
    context: 'рекорд по количеству MVP-матчей за неделю',
    value: (p) => `${p['value']} MVP-матчей`,
  },
  record_longest_match_minutes: {
    emoji: '⏳',
    title: 'Дело принципа',
    context: 'рекорд по длительности матча',
    value: (p) => {
      const rounds = p['rounds'];
      const roundsPart = rounds ? ` (${rounds} раундов)` : '';
      return `${p['value']} минут${roundsPart}`;
    },
  },
};

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
// Defense-in-depth: even though record-kills-per-weapon.ts now whitelists
// these on insert, historical detected_events rows from before the filter
// landed still carry abilities (Curveball, Showstopper, TURRET, …). Filter
// them out at digest build time too.
const DIGEST_ALLOWED_WEAPONS = new Set([
  'Classic', 'Shorty', 'Frenzy', 'Ghost', 'Sheriff',
  'Stinger', 'Spectre',
  'Bucky', 'Judge',
  'Bulldog', 'Guardian',
  'Marshal', 'Outlaw', 'Operator',
  'Ares', 'Odin',
]);

const BRIGHT_EVENT_WEIGHTS: Record<string, number> = {
  record_kills_match: 7,
  record_damage_dealt_match: 7,
  record_damage_received_match: 7,
  record_deaths_match: 7,
  record_headshots_match: 7,
  record_legshots_match: 7,
  record_mvp_count_week: 7,
  record_kills_per_weapon: 7,
  record_longest_match_minutes: 7,
  winstreak_10plus: 4,
  peak_rank_up: 3,
};

function isBrightEvent(eventType: string): boolean {
  return eventType in BRIGHT_EVENT_WEIGHTS;
}

function getBrightEventWeight(eventType: string): number {
  return BRIGHT_EVENT_WEIGHTS[eventType] ?? 0;
}

/**
 * Compute "Был близок к рекорду" blocks for the digest.
 *
 * For each record type in NEAR_MISS_THRESHOLDS that was NOT beaten this week,
 * checks if the week's maximum for that metric is within threshold of the
 * current all-time record. If so, renders a near-miss line.
 *
 * This is a pure render computation — no DB writes.
 */
async function renderNearMisses(
  db: AnyDb,
  weekStart: number,
  weekEnd: number,
  alreadyBeaten: Set<string>,
): Promise<{ blocks: string[]; rich: RichNearMiss[] }> {
  const blocks: string[] = [];
  const rich: RichNearMiss[] = [];

  for (const cfg of NEAR_MISS_THRESHOLDS) {
    if (alreadyBeaten.has(cfg.recordType)) continue;  // actual record event will be rendered instead

    // Fetch current all-time record value
    const [atr] = await db
      .select({ value: allTimeRecords.value })
      .from(allTimeRecords)
      .where(and(eq(allTimeRecords.record_type, cfg.recordType), eq(allTimeRecords.weapon, '')))
      .limit(1);
    if (!atr) continue;  // no record established yet — nothing to be near
    const currentRecord = Number(atr.value);

    // Special case: mvp_count_week is a derived aggregate (SUM of is_match_mvp per player),
    // not a direct column — handle it with its own query branch.
    if (cfg.source === 'mvp_count_week') {
      const [mvpRow] = await db
        .select({
          mvp_count: sql<number>`SUM(${matchRecords.is_match_mvp})`.as('mvp_count'),
          riot_puuid: matchRecords.riot_puuid,
        })
        .from(matchRecords)
        .where(and(
          isNotNull(matchRecords.riot_puuid),
          gte(matchRecords.started_at, weekStart),
          lt(matchRecords.started_at, weekEnd),
        ))
        .groupBy(matchRecords.riot_puuid)
        .orderBy(sql`SUM(${matchRecords.is_match_mvp}) DESC`)
        .limit(1);
      if (!mvpRow || mvpRow.mvp_count == null) continue;
      const weekMax = Number(mvpRow.mvp_count);
      if (cfg.floor != null && weekMax < cfg.floor) continue;
      if (weekMax >= currentRecord) continue;
      if (weekMax < currentRecord - cfg.threshold) continue;
      const [user] = await db
        .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
        .from(users)
        .where(eq(users.riot_puuid, mvpRow.riot_puuid))
        .limit(1);
      const userTag = user ? `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>` : `<b>${esc(String(mvpRow.riot_puuid))}</b>`;
      blocks.push(`${cfg.emoji} <u>${cfg.header}</u>\n${userTag} — ${weekMax} ${cfg.unit}`);
      // mvp_count_week is an aggregate ⇒ no match, no agent, no rank.
      rich.push({
        emoji: cfg.emoji,
        header: cfg.header,
        player: {
          name: user ? user.riot_name : String(mvpRow.riot_puuid),
          tag: user ? user.riot_tag : '',
        },
        value: `${weekMax} ${cfg.unit}`,
      });
      continue;
    }

    // Build the SQL expression for this metric
    const sourceColumnMap = {
      kills: matchRecords.kills,
      deaths: matchRecords.deaths,
      headshots: matchRecords.headshots,
      legshots: matchRecords.legshots,
      damage_dealt: matchRecords.damage_dealt,
      damage_received: matchRecords.damage_received,
      rounds_played: matchRecords.rounds_played,
      died_first_rounds: matchRecords.died_first_rounds,
      // game_length_minutes is handled separately below
    } as const;

    const expr =
      cfg.source === 'game_length_minutes'
        ? sql`CAST(${matchRecords.game_length_ms} / 60000.0 AS INTEGER)`
        : sourceColumnMap[cfg.source as keyof typeof sourceColumnMap];

    // Fetch the week's best for this metric (player with max value)
    const [row] = await db
      .select({
        max_value: sql<number>`MAX(${expr})`.as('max_value'),
        riot_puuid: matchRecords.riot_puuid,
        match_id: matchRecords.match_id,
        // SQLite returns the bare columns from the MAX() row, so `agent` is the
        // agent of the near-miss match — drives the agent emoji next to the nick (#301).
        agent: matchRecords.agent,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .orderBy(desc(expr))
      .limit(1);

    if (!row || row.max_value === null || row.max_value === undefined) continue;
    const weekMax = Number(row.max_value);

    // Double-check: if it's actually >= record it should already be in alreadyBeaten
    if (weekMax >= currentRecord) continue;
    // Check if it's within threshold
    if (weekMax < currentRecord - cfg.threshold) continue;

    // Lookup the player
    const [user] = await db
      .select({ riot_name: users.riot_name, riot_tag: users.riot_tag })
      .from(users)
      .where(eq(users.riot_puuid, row.riot_puuid))
      .limit(1);

    const userTag = user ? `<b>${esc(user.riot_name)}#${esc(user.riot_tag)}</b>` : `<b>${esc(String(row.riot_puuid))}</b>`;
    // Agent emoji next to the nick — near-miss is tied to a specific match (#301).
    const agentEmoji = agentToEmojiHtml(row.agent);
    const agentSuffix = agentEmoji ? ` ${agentEmoji}` : '';
    // New format consistent with bright events: underlined caption, value line.
    // Drops the "(рекорд: X)" prev-record info — same call user made for the
    // record templates.
    blocks.push(`${cfg.emoji} <u>${cfg.header}</u>\n${userTag}${agentSuffix} — ${weekMax} ${cfg.unit}`);
    // Structured near-miss for the rich renderer — tied to the near-miss match,
    // so the agent emoji rides along (no rank-in-match captured for near-miss;
    // the aggregated MAX() row doesn't reliably carry the matching rank_after).
    rich.push({
      emoji: cfg.emoji,
      header: cfg.header,
      player: {
        name: user ? user.riot_name : String(row.riot_puuid),
        tag: user ? user.riot_tag : '',
        agent: row.agent ?? null,
      },
      value: `${weekMax} ${cfg.unit}`,
    });
  }

  return { blocks, rich };
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
  /**
   * Rich Message (Bot API 10.1+) HTML rendering of the SAME digest content
   * (#309). Null iff `text` is null (empty week). Produced in the same single
   * pass over the data as `text`; never drifts from it. Used by the publish
   * tick to `sendRichMessage`, with `text` as the legacy fallback.
   */
  richHtml: string | null;
  sectionsIncluded: string[];
  /**
   * Most-played map this window (top of the Top-Maps GROUP BY), or null.
   * Lifted from the *existing* aggregation — no extra SQL. Used as a
   * reference image for the weekly promo image (#227).
   */
  topMap: string | null;
  /**
   * Most-picked agent this window (top of the Top-Agents GROUP BY), or null.
   * Lifted from the *existing* aggregation — no extra SQL. Used as a
   * reference image for the weekly promo image (#227).
   */
  topAgent: string | null;
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
    return { text: null, richHtml: null, sectionsIncluded: [], topMap: null, topAgent: null };
  }

  // Hoisted out of the Top-Maps / Top-Agents scoped blocks below so the
  // weekly promo image (#227) can pick the strongest single map/agent as a
  // reference. No extra SQL — captured from the existing GROUP BY rows.
  let topMap: string | null = null;
  let topAgent: string | null = null;

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
  // Weapons section renders last in the bright area — collected separately so
  // it can be appended after near-miss blocks too.
  const weaponsBlocks: string[] = [];
  // Structured weapons-masters rows for the rich «Мастера своего дела» table
  // (#309). Populated from the same merged weapons group that produces the
  // legacy text block — sorted desc by value, mirroring renderDigestGroup.
  const richWeaponMasters: RichWeaponMaster[] = [];
  // Structured rich-model captures (#315), populated in the SAME pass as the
  // legacy text so they never drift. Records → <details> accordions; winstreak
  // → card; peak_rank_up → «Повышение по службе» table.
  const richRecords: RichRecord[] = [];
  const richWinstreaks: RichWinstreak[] = [];
  const richPromotions: RichPromotion[] = [];

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

    // Phase 1: gather full entries (payload + user + match) for each event
    type Entry = {
      eventType: EventType;
      payload: Record<string, unknown>;
      user: TemplateUser;
      match?: TemplateMatch;
      /** Player's rank in the attached match (Henrik tier name) — rich accordions (#315). */
      rank?: string;
      /** The real tracker match id for the accordion link (record_kills_per_weapon uses real_match_id). */
      richMatchId?: string;
    };
    const entries: Entry[] = [];

    for (const ev of sorted) {
      const puuid = ev.riot_puuid as string;
      const user = await getUserByPuuid(puuid);
      if (!user) continue;

      // peak_rank_up renders even for opted-out players (positive progress)
      // Other bright events: skip opted-out players
      if (ev.event_type !== 'peak_rank_up' && optedOut.has(user.telegram_id)) continue;

      const payload = safeParseJson(ev.payload_json as string);

      // Only canonical Valorant weapons count for "Эксперт по …" records —
      // skip abilities/utilities/empty/UUID weapon names. The detector now
      // applies the same whitelist on insert, but historical detected_events
      // rows still carry stale entries and would render as e.g.
      // "Эксперт по Curveball" / "Эксперт по Showstopper" / "Эксперт по ".
      if (ev.event_type === 'record_kills_per_weapon') {
        const w = String(payload['weapon'] ?? '');
        if (!DIGEST_ALLOWED_WEAPONS.has(w)) continue;
      }

      // record_kills_per_weapon uses a synthetic match_id (match_id#kpw-WEAPON) for dedup.
      // The real match_id is stored in payload.real_match_id.
      const realMatchId: string =
        ev.event_type === 'record_kills_per_weapon'
          ? String(payload['real_match_id'] ?? '')
          : String(ev.match_id ?? '');

      // Fetch map/agent/rank from match_records. `rank_after` is the player's
      // rank in that match (Henrik tier name, e.g. "Diamond 3") — drives the
      // rank emoji left of the nick in the rich accordion (#312/#315). Null for
      // older matches or unrated modes ⇒ rank icon omitted (not a blocker).
      const [matchRow] = realMatchId
        ? await db
            .select({ map: matchRecords.map, agent: matchRecords.agent, rank_after: matchRecords.rank_after })
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
      const agent: string | undefined = matchRow?.agent ?? undefined;
      const rankAfter: string | undefined = matchRow?.rank_after ?? undefined;

      const tplUser: TemplateUser = {
        riot_name: user.riot_name,
        riot_tag: user.riot_tag,
        telegram_id: user.telegram_id,
        riot_puuid: puuid,
      };

      const tplMatch: TemplateMatch = {};
      if (map) tplMatch.map = map;
      if (ev.match_id) tplMatch.match_id = String(ev.match_id);
      if (agent) tplMatch.agent = agent;

      const entry: Entry = {
        eventType: ev.event_type as EventType,
        payload,
        user: tplUser,
      };
      if (map || ev.match_id || agent) entry.match = tplMatch;
      if (rankAfter) entry.rank = rankAfter;
      // realMatchId is the tracker match for the accordion link. Empty for
      // aggregate records (record_mvp_count_week has no single match).
      if (realMatchId) entry.richMatchId = realMatchId;
      entries.push(entry);
    }

    // Phase 2: collect entries into groups, preserving sort order of first occurrence.
    //   - record_kills_per_weapon: one group per weapon (key = `kpw:<weapon>`)
    //   - everything else: one group per event_type
    type Group = { eventType: EventType; entries: Entry[] };
    const groups: Group[] = [];
    const groupByKey = new Map<string, Group>();

    for (const e of entries) {
      const key = e.eventType === 'record_kills_per_weapon'
        ? `kpw:${String(e.payload['weapon'] ?? '?')}`
        : `et:${e.eventType}`;
      let group = groupByKey.get(key);
      if (!group) {
        group = { eventType: e.eventType, entries: [] };
        groupByKey.set(key, group);
        groups.push(group);
      }
      group.entries.push(e);
    }

    // Phase 2.5: dedup record_*_match groups. Multiple events for the same
    // record type can land in one week if the all-time record was beaten
    // several times in sequence (e.g. 16 → 18 → 24 → 27 kills). We show only
    // the final (max value) entry, but rewrite its prev_* payload fields to
    // reference the record state from BEFORE the week — i.e. the prev_* of
    // the earliest entry in the chain (entries are sorted by detected_at asc).
    const SINGLE_RECORD_TYPES = new Set<string>([
      'record_kills_match',
      'record_deaths_match',
      'record_headshots_match',
      'record_legshots_match',
      'record_damage_dealt_match',
      'record_damage_received_match',
      'record_longest_match_minutes',
      'record_mvp_count_week',
      'record_kills_per_weapon',
    ]);

    for (const g of groups) {
      if (!SINGLE_RECORD_TYPES.has(g.eventType) || g.entries.length < 2) continue;
      let maxIdx = 0;
      let maxValue = Number(g.entries[0]!.payload['value'] ?? 0);
      for (let i = 1; i < g.entries.length; i++) {
        const v = Number(g.entries[i]!.payload['value'] ?? 0);
        if (v > maxValue) {
          maxValue = v;
          maxIdx = i;
        }
      }
      const winner = g.entries[maxIdx]!;
      const earliest = g.entries[0]!;
      const mergedPayload: Record<string, unknown> = {
        ...winner.payload,
        prev_value: earliest.payload['prev_value'] ?? null,
        prev_puuid: earliest.payload['prev_puuid'] ?? null,
        prev_name: earliest.payload['prev_name'] ?? null,
        prev_tag: earliest.payload['prev_tag'] ?? null,
      };
      g.entries = [{ ...winner, payload: mergedPayload }];
    }

    // Phase 2.6: dedup peak_rank_up by player. A player can rank up multiple
    // times in a week (Diamond 1 → 2 → 3) and the scanner emits one event per
    // tier transition; show only their final (highest) peak — one line per
    // player. Peak only ever increases, so the highest to_tier_id is also the
    // latest; we tie-break / fall back to the latest entry on missing ids.
    for (const g of groups) {
      if (g.eventType !== 'peak_rank_up' || g.entries.length < 2) continue;
      const bestByPuuid = new Map<string, Entry>();
      const order: string[] = [];
      for (const e of g.entries) {
        const puuid = e.user.riot_puuid ?? `${e.user.riot_name}#${e.user.riot_tag}`;
        const existing = bestByPuuid.get(puuid);
        if (!existing) {
          order.push(puuid);
          bestByPuuid.set(puuid, e);
          continue;
        }
        const cur = Number(e.payload['to_tier_id'] ?? 0);
        const prev = Number(existing.payload['to_tier_id'] ?? 0);
        if (cur >= prev) bestByPuuid.set(puuid, e);
      }
      g.entries = order.map((p) => bestByPuuid.get(p)!);
    }

    // Phase 2.9: merge all per-weapon kills_per_weapon groups into ONE group.
    // After per-weapon dedup (Phase 2.5), each weapon has its single best entry;
    // we now collapse all weapons into a single group so the digest renders one
    // combined "Оружейная мастерская" section instead of N separate "Эксперт по X"
    // blocks. The combined renderer lives in renderDigestGroup.
    const kpwGroups = groups.filter((g) => g.eventType === 'record_kills_per_weapon');
    if (kpwGroups.length > 0) {
      const merged: Group = {
        eventType: 'record_kills_per_weapon',
        entries: kpwGroups.flatMap((g) => g.entries),
      };
      // Remove the original per-weapon groups, append the merged one.
      let idx: number;
      while ((idx = groups.findIndex((g) => g.eventType === 'record_kills_per_weapon')) !== -1) {
        groups.splice(idx, 1);
      }
      groups.push(merged);
    }

    // Phase 3: render each group
    const GROUP_CAPABLE_TYPES = new Set<string>([
      'winstreak_10plus',
      'peak_rank_up',
      'record_kills_per_weapon',
    ]);
    const renderGroup = (g: Group): string => {
      if (g.entries.length >= 2 && GROUP_CAPABLE_TYPES.has(g.eventType)) {
        return renderDigestGroup(g.eventType, g.entries);
      }
      if (g.eventType === 'record_kills_per_weapon' && g.entries.length === 1) {
        // Single weapon record this week — still use the combined renderer for
        // consistency (one-line section with the same header), not the legacy
        // per-weapon template.
        return renderDigestGroup(g.eventType, g.entries);
      }
      // Single-event format via renderTemplate. If a group-capable type has length === 1,
      // we still use the single-event template (which has the singular header).
      return g.entries
        .map((e) => renderTemplate(e.eventType, e.payload, e.user, e.match))
        .join('\n\n');
    };
    // Capture structured rich data for one group in the SAME order as the
    // legacy text. Records → accordions; winstreak → card; peak_rank_up → table.
    const captureRich = (g: Group): void => {
      if (g.eventType === 'winstreak_10plus') {
        for (const e of g.entries) {
          richWinstreaks.push({
            name: e.user.riot_name,
            tag: e.user.riot_tag,
            streak: Number(e.payload['streak'] ?? 10),
          });
        }
        return;
      }
      if (g.eventType === 'peak_rank_up') {
        for (const e of g.entries) {
          const to = e.payload['to_tier_name'];
          if (to == null || to === '') continue;
          richPromotions.push({
            name: e.user.riot_name,
            tag: e.user.riot_tag,
            rank: String(to),
          });
        }
        return;
      }
      const meta = RICH_RECORD_META[g.eventType];
      if (!meta) return;
      for (const e of g.entries) {
        // Aggregate records (record_mvp_count_week) have no single match ⇒ no
        // link, no agent, no rank. Others link to their tracker match.
        const isAggregate = g.eventType === 'record_mvp_count_week';
        const matchUrl =
          !isAggregate && e.richMatchId
            ? `https://tracker.gg/valorant/match/${e.richMatchId}`
            : null;
        richRecords.push({
          emoji: meta.emoji,
          title: meta.title,
          player: {
            name: e.user.riot_name,
            tag: e.user.riot_tag,
            rank: isAggregate ? null : e.rank ?? null,
            agent: isAggregate ? null : e.match?.agent ?? null,
          },
          value: meta.value(e.payload),
          matchUrl,
          mapName: isAggregate ? null : e.match?.map ?? null,
          context: meta.context,
        });
      }
    };

    for (const g of groups) {
      // Skip weapons here — rendered last (just above weekly recap) per user.
      if (g.eventType === 'record_kills_per_weapon') continue;
      brightBlocks.push(renderGroup(g));
      captureRich(g);
      sectionsIncluded.push(g.eventType);
    }
    // Render weapons last so it sits right above the always-bottom recap,
    // AFTER the near-miss blocks too — collected in `weaponsBlocks` and
    // appended after near-miss in the final concat below.
    const weaponsGroup = groups.find((g) => g.eventType === 'record_kills_per_weapon');
    if (weaponsGroup) {
      weaponsBlocks.push(renderGroup(weaponsGroup));
      sectionsIncluded.push(weaponsGroup.eventType);
      // Capture structured rows for the rich table — same weapon/value/player
      // and same desc-by-value sort as renderDigestGroup's weapons branch.
      for (const e of [...weaponsGroup.entries].sort(
        (a, b) => Number(b.payload['value'] ?? 0) - Number(a.payload['value'] ?? 0),
      )) {
        const weapon = String(e.payload['weapon'] ?? '?');
        richWeaponMasters.push({
          weaponEmojiHtml: weaponToEmojiHtml(weapon) || '🎯',
          weapon,
          value: Number(e.payload['value'] ?? 0),
          // Canonical nick render (#315 rule 1). Weapon-table rows carry no
          // rank/agent per the approved layout ⇒ plain bold Ник#Тег.
          playerHtml: renderPlayerName({
            name: e.user.riot_name,
            tag: e.user.riot_tag,
            isCommunity: true,
          }),
        });
      }
    }
  }

  // ─── NEAR-MISS BLOCKS ────────────────────────────────────────────────────────
  // Collect record types beaten this week so we skip near-miss for those
  const alreadyBeaten = new Set<string>();
  {
    const recordEventPrefix = 'record_';
    for (const sectionKey of sectionsIncluded) {
      if (sectionKey.startsWith(recordEventPrefix)) {
        // e.g. "record_kills_match" → "kills_match"
        alreadyBeaten.add(sectionKey.slice(recordEventPrefix.length));
      }
    }
  }

  const { blocks: nearMissBlocks, rich: richNearMisses } = await renderNearMisses(
    db,
    weekStart,
    weekEnd,
    alreadyBeaten,
  );
  if (nearMissBlocks.length > 0) {
    sectionsIncluded.push('nearMiss');
  }

  // ─── ALWAYS-SECTIONS ─────────────────────────────────────────────────────────
  const alwaysSections: string[] = [];

  // Structured rich-model fields for the bottom sections (#309), captured in
  // the same pass as the legacy text.
  let richMostActive: { nameHtml: string; count: number } | null = null;
  const richTopMaps: RichDigestModel['topMaps'] = [];
  const richTopAgents: RichDigestModel['topAgents'] = [];

  // Pulse (simplified)
  {
    alwaysSections.push(`📊 За неделю мы сыграли <b>${totalMatches}</b> матчей`);
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

      // Canonical nick render (#315 rule 1). Weekly aggregate — no match
      // attached ⇒ just bold Ник#Тег (no rank/agent icons).
      const name = renderPlayerName({
        name: user.riot_name,
        tag: user.riot_tag,
        isCommunity: true,
      });
      alwaysSections.push(`🏆 Больше всех матчей\n${name} - ${cnt} за неделю`);
      richMostActive = { nameHtml: name, count: cnt };
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

    topMap = maps[0]?.map != null ? String(maps[0].map) : null;

    if (maps.length > 0) {
      const mapLines = maps
        .map((m: { map: string; cnt: number }) => {
          const icon = mapToEmojiHtml(String(m.map));
          return `• ${icon ? `${icon} ` : ''}<b>${esc(String(m.map))}</b> (${Number(m.cnt)}×)`;
        })
        .join('\n');
      alwaysSections.push(`🗺 Чаще всего играли на:\n${mapLines}`);
      for (const m of maps as Array<{ map: string; cnt: number }>) {
        richTopMaps.push({
          emojiHtml: mapToEmojiHtml(String(m.map)),
          map: String(m.map),
          count: Number(m.cnt),
        });
      }
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

    topAgent = agents[0]?.agent != null ? String(agents[0].agent) : null;

    if (agents.length > 0) {
      const agentLines = agents
        .map((a: { agent: string; cnt: number }) => {
          const icon = agentToEmojiHtml(String(a.agent));
          return `• ${icon ? `${icon} ` : ''}<b>${esc(String(a.agent))}</b> (${Number(a.cnt)}×)`;
        })
        .join('\n');
      alwaysSections.push(`🎭 Чаще всего пикали:\n${agentLines}`);
      for (const a of agents as Array<{ agent: string; cnt: number }>) {
        richTopAgents.push({
          emojiHtml: agentToEmojiHtml(String(a.agent)),
          agent: String(a.agent),
          count: Number(a.cnt),
        });
      }
      sectionsIncluded.push('topAgents');
    }
  }

  // ─── Compose ─────────────────────────────────────────────────────────────────
  const parts: string[] = [header];

  // Order in the bright area: regular bright blocks → near-miss → weapons.
  // Weapons sit last so they're right above the always-bottom recap.
  const allBrightBlocks = [...brightBlocks, ...nearMissBlocks, ...weaponsBlocks];
  if (allBrightBlocks.length > 0) {
    parts.push('');
    parts.push(allBrightBlocks.join('\n\n'));
  }

  parts.push('');
  // Blank line between each sub-section of the weekly recap (matches / top
  // player / top maps / top agents) so they breathe instead of mushing into
  // one block.
  parts.push(alwaysSections.join('\n\n'));
  parts.push('');
  parts.push('#digest');

  const text = parts.join('\n');

  // ─── Rich rendering (#315) — SAME data, parallel renderer ────────────────────
  // Built from the structured section data captured above, so every section in
  // the legacy `text` is present in the rich HTML. `topMap` (the strongest map
  // of the week, already computed for the promo image) drives the cover splash.
  const richHtml = renderRichDigest({
    headerDate,
    coverMap: topMap,
    totalMatches,
    records: richRecords,
    winstreaks: richWinstreaks,
    promotions: richPromotions,
    weaponMasters: richWeaponMasters,
    nearMisses: richNearMisses,
    mostActive: richMostActive,
    topMaps: richTopMaps,
    topAgents: richTopAgents,
  });

  return { text, richHtml, sectionsIncluded, topMap, topAgent };
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
