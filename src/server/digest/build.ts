/**
 * build.ts — Aggregator for the weekly digest.
 *
 * Queries the DB over a rolling 7-day window and assembles ONE structured
 * `RichDigestModel`. It does not format anything: `rich-render.ts` turns that
 * model into both the Rich Message html and the plain-text fallback. (Until
 * 2026-08 this file also hand-assembled a parallel legacy text through
 * publisher/templates.ts — two formats that had to be kept in sync by hand.)
 *
 * Section order in the rendered digest:
 *   Pulse
 *   → bright records (record_*_match, record_mvp_count_week,
 *     record_longest_match_minutes)
 *   → 🎯 Эйсы недели / 🔪 Ножи недели  (see ./ace-knife.ts)
 *   → winstreak → weapons masters → promotions → near-misses
 *   → most-active → top maps → top agents → #digest
 *
 * Everything reads from `match_records` / `detected_events`, which only ever
 * carry ranked (`console_competitive`) matches — the scanner drops every other
 * queue, so every record and leaderboard here is ranked-only by construction.
 *
 * Anti-coercion: NEVER mentions who didn't play, who opted out, or
 * includes "play more / come back" calls (memory rule: valorant_no_qol_coercion).
 */

import { and, gte, lt, sql, eq, isNotNull } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { optOuts } from '../db/schema/opt_outs.ts';
import { allTimeRecords } from '../db/schema/all_time_records.ts';
import { computeAndEmitWeeklyMvpRecord } from './weekly-mvp-record.ts';
import { computeWeekIso } from '../lib/kyiv-week.ts';
import { NEAR_MISS_THRESHOLDS } from './near-miss-config.ts';
import type { TemplateUser, TemplateMatch } from '../publisher/templates.ts';
import { renderPlayerName } from '../publisher/player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml, weaponToEmojiHtml } from '../publisher/valorant-emoji.ts';
import type { EventType } from '../publisher/types.ts';
import { buildAceKnifeStandings } from './ace-knife.ts';
import {
  renderDigest,
  type RichDigestModel,
  type RichWeaponMaster,
  type RichRecord,
  type RichWinstreak,
  type RichPromotion,
  type RichNearMiss,
  type RichPlayerRef,
} from './rich-render.ts';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/**
 * Per-record-type display metadata. `emoji` + `title` make the record's first
 * line; `value(payload)` formats the value WITHOUT the nick/link (those come
 * from the shared render helpers).
 *
 * `context` is retained but no longer rendered — the flat layout dropped the
 * explanation line that used to live inside each record's `<details>` body.
 * This table is now the SOLE source of record copy for the digest; the
 * matching entries in publisher/templates.ts serve the realtime path only.
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
  record_died_first_rounds: {
    emoji: '🐴',
    title: 'Троянский конь',
    context: 'рекорд по количеству раундов в матче, где игрок умирал первым из своей команды',
    value: (p) => `${p['value']} первых смертей`,
  },
  record_survived_last_rounds: {
    emoji: '⚓',
    title: 'Якорь',
    context: 'рекорд по количеству раундов в матче, где игрок умирал последним из своей команды',
    value: (p) => `${p['value']} последних смертей`,
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
  record_died_first_rounds: 7,
  record_survived_last_rounds: 7,
  winstreak_10plus: 4,
  peak_rank_up: 3,
};

/**
 * Map an `event_type` to the `all_time_records.record_type` it maintains.
 *
 * The convention is a plain prefix strip (`record_kills_match` →
 * `kills_match`), but two detectors ship an extra `_match` suffix on the
 * record type while their event type has none. Without this override the
 * near-miss suppression misses them, and the digest could print «чуть не стал
 * троянским конём» right next to the actual Троянский конь record.
 */
const RECORD_TYPE_OVERRIDES: Record<string, string> = {
  record_died_first_rounds: 'died_first_rounds_match',
  record_survived_last_rounds: 'survived_last_rounds_match',
};

function recordTypeForEvent(eventType: string): string {
  return RECORD_TYPE_OVERRIDES[eventType] ?? eventType.slice('record_'.length);
}

/**
 * Every puuid an event's award names, the event's own player first.
 *
 * `detected_events` is unique on (match_id, event_type, riot_puuid) and
 * `weekly_records` is keyed (record_type, week_iso) — both structurally name
 * ONE player — so a shared award can only travel in the payload.
 * `weekly-mvp-record.ts` writes every co-king into `payload.puuids`; every
 * single-holder record, and every event emitted before that field existed, has
 * none and falls back to the row's own puuid.
 */
function awardHolderPuuids(payload: Record<string, unknown>, primary: string): string[] {
  const listed = payload['puuids'];
  if (!Array.isArray(listed)) return [primary];
  return [...new Set([primary, ...listed.map((h) => String(h))])];
}

function isBrightEvent(eventType: string): boolean {
  return eventType in BRIGHT_EVENT_WEIGHTS;
}

function getBrightEventWeight(eventType: string): number {
  return BRIGHT_EVENT_WEIGHTS[eventType] ?? 0;
}

/**
 * One candidate for a near-miss: a player's week-best for the metric, the match
 * it came from, and the nick we need in order to name them. The `users` columns
 * arrive by LEFT JOIN, so they are null for a puuid with no member row (a
 * departed member — `match_records.riot_puuid` is ON DELETE SET NULL — or a
 * player whose matches were scanned before onboarding).
 */
interface NearMissCandidate {
  value: number | null;
  riot_name: string | null;
  riot_tag: string | null;
  telegram_id: number | null;
  match_id?: string | null;
  agent?: string | null;
  map?: string | null;
}

/**
 * Pick everyone who shares the week's best among the players we may name.
 * Rows arrive desc by value; the walk stops at the first value below the best
 * ELIGIBLE one.
 *
 * Two rules the near-miss section was missing entirely:
 *   - opted-out members are dropped, the way bright events and the ace/knife
 *     boards drop them. Near-misses were the ONE section that never consulted
 *     the set, so an opted-out member's week-best was still read out to the
 *     group — and opt-out is a promise to that member.
 *   - a puuid with no `users` row is dropped rather than printed: the old
 *     fallback was `String(row.riot_puuid)`, i.e. a 78-character raw PUUID
 *     landing in the group chat as a nick.
 * Skipping them does not take the block down — the next player who genuinely
 * was close still gets their line, exactly as «Больше всех матчей» walks past
 * an opted-out leader.
 *
 * Everyone tied on the best value is named. `LIMIT 1` handed the block to
 * whichever equal row the scan reached first and dropped the co-holder
 * silently — the same class of bug the owner called out on the Эйсы podium
 * (2026-08-09), fixed there by naming everyone tied. The SQL orders ties by
 * puuid, so their order is stable between two runs of the same digest.
 */
function eligibleNearMissHolders(
  rows: NearMissCandidate[],
  optedOutTelegramIds: Set<number>,
): { value: number; players: RichPlayerRef[] } | null {
  let best: number | null = null;
  const players: RichPlayerRef[] = [];

  for (const row of rows) {
    if (row.value == null) continue;
    const value = Number(row.value);
    if (best !== null && value < best) break;
    // No nick ⇒ nothing to render. No telegram_id ⇒ cannot be opted out.
    if (row.riot_name == null) continue;
    if (row.telegram_id != null && optedOutTelegramIds.has(row.telegram_id)) continue;

    best = value;
    players.push({
      name: row.riot_name,
      tag: row.riot_tag ?? '',
      // The near-miss match rides along: it drives the agent emoji next to the
      // nick (#301) and the match link (owner, 2026-08-04). No rank-in-match —
      // the aggregated MAX() row doesn't reliably carry the matching
      // rank_after. Aggregate metrics (mvp_count_week) select no match columns
      // at all, so both come out null.
      agent: row.agent ?? null,
      matchUrl: row.match_id ? `https://tracker.gg/valorant/match/${String(row.match_id)}` : null,
      mapName: row.map ?? null,
    });
  }

  return best === null ? null : { value: best, players };
}

/**
 * Compute "Был близок к рекорду" blocks for the digest.
 *
 * For each record type in NEAR_MISS_THRESHOLDS that was NOT beaten this week,
 * checks if the week's maximum for that metric is within threshold of the
 * current all-time record. If so, renders a near-miss line.
 *
 * `optedOutTelegramIds` is dropped before the week's best is picked — see
 * `eligibleNearMissHolders` for why this section needed it and did not have it.
 *
 * This is a pure render computation — no DB writes.
 */
async function renderNearMisses(
  db: AnyDb,
  weekStart: number,
  weekEnd: number,
  alreadyBeaten: Set<string>,
  optedOutTelegramIds: Set<number>,
): Promise<RichNearMiss[]> {
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
      const mvpRows = await db
        .select({
          value: sql<number>`SUM(${matchRecords.is_match_mvp})`.as('mvp_count'),
          riot_name: users.riot_name,
          riot_tag: users.riot_tag,
          telegram_id: users.telegram_id,
        })
        .from(matchRecords)
        .leftJoin(users, eq(users.riot_puuid, matchRecords.riot_puuid))
        .where(and(
          isNotNull(matchRecords.riot_puuid),
          gte(matchRecords.started_at, weekStart),
          lt(matchRecords.started_at, weekEnd),
        ))
        .groupBy(matchRecords.riot_puuid)
        // Desc by count, then puuid: co-holders all get named, but the order
        // in which they are named must not wobble between two runs.
        .orderBy(sql`SUM(${matchRecords.is_match_mvp}) DESC`, matchRecords.riot_puuid);

      const holders = eligibleNearMissHolders(mvpRows, optedOutTelegramIds);
      if (!holders) continue;
      const weekMax = holders.value;
      if (cfg.floor != null && weekMax < cfg.floor) continue;
      if (weekMax >= currentRecord) continue;
      if (weekMax < currentRecord - cfg.threshold) continue;
      // mvp_count_week is an aggregate ⇒ no match, no agent, no rank.
      rich.push({
        emoji: cfg.emoji,
        header: cfg.header,
        players: holders.players,
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

    // Every player's week-best for this metric, best first. SQLite's
    // bare-column rule hands back `match_id`/`agent`/`map` from the row that
    // produced each player's MAX — that IS the near-miss match, and it drives
    // the agent emoji next to the nick (#301) and the match link (owner,
    // 2026-08-04).
    //
    // The GROUP BY is the fix, not decoration: this used to be one bare
    // `MAX()` over the whole table, which returns exactly ONE row, so its
    // `ORDER BY …, riot_puuid` tie-break never ran at all and a second player
    // on the same week-best was dropped by the query itself.
    const rows = await db
      .select({
        value: sql<number>`MAX(${expr})`.as('max_value'),
        match_id: matchRecords.match_id,
        agent: matchRecords.agent,
        map: matchRecords.map,
        riot_name: users.riot_name,
        riot_tag: users.riot_tag,
        telegram_id: users.telegram_id,
      })
      .from(matchRecords)
      .leftJoin(users, eq(users.riot_puuid, matchRecords.riot_puuid))
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.riot_puuid)
      .orderBy(sql`MAX(${expr}) DESC`, matchRecords.riot_puuid);

    const holders = eligibleNearMissHolders(rows, optedOutTelegramIds);
    if (!holders) continue;
    const weekMax = holders.value;

    // Double-check: if it's actually >= record it should already be in alreadyBeaten
    if (weekMax >= currentRecord) continue;
    // Check if it's within threshold
    if (weekMax < currentRecord - cfg.threshold) continue;

    rich.push({
      emoji: cfg.emoji,
      header: cfg.header,
      players: holders.players,
      value: `${weekMax} ${cfg.unit}`,
    });
  }

  return rich;
}

export interface BuildDigestDeps {
  db: AnyDb;
  /** Window start in ms (inclusive). */
  weekStart: number;
  /** Window end in ms (exclusive). */
  weekEnd: number;
  /**
   * Build WITHOUT touching persistent state — for the owner's `/test_digest`
   * preview. Building a digest normally computes and records the weekly MVP
   * record first, which is a WRITE: a preview over an arbitrary window (say 30
   * days) would stamp that 30-day count onto the current week's record row and
   * insert a `record_mvp_count_week` event dated now — landing a bogus «👑
   * Король MVP за неделю» in the group's next real digest, and raising the
   * all-time bar so a genuine weekly record could never beat it again.
   */
  readOnly?: boolean;
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
  if (!deps.readOnly) {
    // The window's own name: the ISO week of its closing Friday. `lib/kyiv-week.ts`
    // is the single source for it — `records-rebuild.ts` keys the same window the
    // same way, which is what stops a rebuild from contesting this row.
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
  // ─── BRIGHT EVENTS (top block) ───────────────────────────────────────────────
  // Structured model captures — the ONE representation of each section. Both
  // the rich html and the plain-text fallback are rendered from these by
  // `renderDigest`, so there is no second hand-maintained text assembly to
  // drift from (pre-2026-08 build.ts kept both).
  const richWeaponMasters: RichWeaponMaster[] = [];
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
      /**
       * First holder — the single-player face used by the winstreak /
       * promotion / weapons branches, which can never be shared.
       */
      user: TemplateUser;
      /**
       * Everyone the award names, `user` first. Longer than one entry only for
       * the aggregate weekly-MVP record, where the crown is shared.
       */
      holders: TemplateUser[];
      match?: TemplateMatch;
      /** Player's rank in the attached match (Henrik tier name) — rich accordions (#315). */
      rank?: string;
      /** The real tracker match id for the accordion link (record_kills_per_weapon uses real_match_id). */
      richMatchId?: string;
    };
    const entries: Entry[] = [];

    for (const ev of sorted) {
      const puuid = ev.riot_puuid as string;
      const payload = safeParseJson(ev.payload_json as string);

      // Everyone this award names, the event's own player first. All but the
      // aggregate weekly-MVP record have exactly one holder; a tied «👑 Король
      // MVP» rides its co-kings in `payload.puuids` because neither the event
      // row nor `weekly_records` can hold more than one, and a genuine
      // co-leader used to vanish without a trace (owner, 2026-08-09).
      const holders: TemplateUser[] = [];
      for (const holderPuuid of awardHolderPuuids(payload, puuid)) {
        const holder = await getUserByPuuid(holderPuuid);
        if (!holder) continue;
        // peak_rank_up renders even for opted-out players (positive progress)
        // Other bright events: skip opted-out players
        if (ev.event_type !== 'peak_rank_up' && optedOut.has(holder.telegram_id)) continue;
        holders.push({
          riot_name: holder.riot_name,
          riot_tag: holder.riot_tag,
          telegram_id: holder.telegram_id,
          riot_puuid: holderPuuid,
        });
      }
      // Nobody left to name — an opted-out sole holder drops the award, but an
      // opted-out FIRST holder no longer takes the co-kings down with them.
      if (holders.length === 0) continue;
      const user = holders[0]!;

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

      const tplMatch: TemplateMatch = {};
      if (map) tplMatch.map = map;
      if (ev.match_id) tplMatch.match_id = String(ev.match_id);
      if (agent) tplMatch.agent = agent;

      const entry: Entry = {
        eventType: ev.event_type as EventType,
        payload,
        user,
        holders,
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

    // Phase 2.5: dedup record_* groups. Multiple events for the same record
    // type can land in one week if the all-time record was beaten several times
    // in sequence (e.g. 16 → 18 → 24 → 27 kills, by one player or by several).
    // We show only the final (max value) entry, but rewrite its prev_* payload
    // fields to reference the record state from BEFORE the week — i.e. the
    // prev_* of the earliest entry in the chain (entries are sorted by
    // detected_at asc).
    //
    // EVERY `record_*` group collapses. This used to be an opt-in allowlist,
    // which silently failed open: `record_died_first_rounds` /
    // `record_survived_last_rounds` were added to the digest without being
    // added to the list, so one week rendered «🐴 Троянский конь» four times
    // (1 → 3 → 4 → 9 первых смертей) and «⚓ Якорь» twice (owner, 2026-08-09).
    // Collapsing by rule means a new record type is correct by default, and
    // opting one OUT is now the conscious act. `record_kills_per_weapon` is
    // safe here: its groups are keyed per weapon (`kpw:<weapon>`), so the max
    // is taken within one weapon, not across the armoury.
    const isCollapsibleRecord = (eventType: string): boolean =>
      eventType.startsWith('record_');

    for (const g of groups) {
      if (!isCollapsibleRecord(g.eventType) || g.entries.length < 2) continue;
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

    // Phase 2.7: dedup winstreak_10plus by player — one line per player, their
    // longest streak. The detector guards one event per ISO week per player,
    // but the digest window is a rolling Fri→Fri seven days that straddles two
    // ISO weeks, so a player on a long run legitimately has two events inside
    // one window and used to get two «N побед подряд» lines.
    for (const g of groups) {
      if (g.eventType !== 'winstreak_10plus' || g.entries.length < 2) continue;
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
        if (Number(e.payload['streak'] ?? 0) > Number(existing.payload['streak'] ?? 0)) {
          bestByPuuid.set(puuid, e);
        }
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

    // Phase 3: capture each group into the structured model, in display order.
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
          // Every holder under ONE title. The renderer keys blocks by
          // emoji+title, so co-kings MUST arrive as several players in one
          // record — several records would collapse back to a single name.
          players: e.holders.map((h) => ({
            name: h.riot_name,
            tag: h.riot_tag,
            rank: isAggregate ? null : e.rank ?? null,
            agent: isAggregate ? null : e.match?.agent ?? null,
            matchUrl,
            mapName: isAggregate ? null : e.match?.map ?? null,
          })),
          value: meta.value(e.payload),
          context: meta.context,
        });
      }
    };

    for (const g of groups) {
      // Skip weapons here — rendered last (just above weekly recap) per user.
      if (g.eventType === 'record_kills_per_weapon') continue;
      captureRich(g);
      sectionsIncluded.push(g.eventType);
    }
    // Weapons sit last so they're right above the always-bottom recap.
    const weaponsGroup = groups.find((g) => g.eventType === 'record_kills_per_weapon');
    if (weaponsGroup) {
      sectionsIncluded.push(weaponsGroup.eventType);
      // Sorted desc by value — the display order of «Мастера своего дела».
      for (const e of [...weaponsGroup.entries].sort(
        (a, b) => Number(b.payload['value'] ?? 0) - Number(a.payload['value'] ?? 0),
      )) {
        const weapon = String(e.payload['weapon'] ?? '?');
        richWeaponMasters.push({
          weaponEmojiHtml: weaponToEmojiHtml(weapon) || '🎯',
          weapon,
          value: Number(e.payload['value'] ?? 0),
          // Per-match record ⇒ link the match it happened in (owner,
          // 2026-08-04). `richMatchId` is already the REAL match id here —
          // record_kills_per_weapon dedups on a synthetic `<match>#kpw-<w>`.
          matchUrl: e.richMatchId ? `https://tracker.gg/valorant/match/${e.richMatchId}` : null,
          mapName: e.match?.map ?? null,
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
        alreadyBeaten.add(recordTypeForEvent(sectionKey));
      }
    }
  }

  const richNearMisses = await renderNearMisses(db, weekStart, weekEnd, alreadyBeaten, await getOptOutSet());
  if (richNearMisses.length > 0) {
    sectionsIncluded.push('nearMiss');
  }

  // ─── ACE / KNIFE LEADERBOARDS ────────────────────────────────────────────────
  // Formerly the standalone 23:00 daily digest. Now plain per-player counts —
  // «кто сколько эйсов сделал, кто сколько ножей сделал» (owner, 2026-08-04).
  const { aces: richAces, knives: richKnives } = await buildAceKnifeStandings(
    db,
    weekStart,
    weekEnd,
    await getOptOutSet(),
  );
  if (richAces.length > 0) sectionsIncluded.push('aces');
  if (richKnives.length > 0) sectionsIncluded.push('knives');

  // ─── ALWAYS-SECTIONS ─────────────────────────────────────────────────────────
  let richMostActive: { namesHtml: string[]; count: number } | null = null;
  const richTopMaps: RichDigestModel['topMaps'] = [];
  const richTopAgents: RichDigestModel['topAgents'] = [];

  sectionsIncluded.push('pulse');

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
      // The tie-break keeps the board deterministic — SQLite is free to order
      // equal COUNT(*) rows however it likes, which made a tie's winner an
      // artefact of the query plan.
      .orderBy(sql`COUNT(*) DESC`, matchRecords.riot_puuid);

    // Every player on the winning count shares the title. Walking past the
    // first eligible row (the old `break`) is the point: a tie used to hand the
    // crown to one arbitrary player and drop the rest without a trace.
    const leaders: string[] = [];
    let leaderCount = 0;
    for (const row of candidates) {
      const puuid = row.riot_puuid as string;
      const cnt = Number(row.cnt);
      if (cnt < 5) break;
      if (leaders.length > 0 && cnt < leaderCount) break;

      const user = await getUserByPuuid(puuid);
      if (!user) continue;
      if (optedOut.has(user.telegram_id)) continue;

      // Canonical nick render (#315 rule 1). Weekly aggregate — no match
      // attached ⇒ just bold Ник#Тег (no rank/agent icons).
      leaders.push(renderPlayerName({
        name: user.riot_name,
        tag: user.riot_tag,
        isCommunity: true,
      }));
      leaderCount = cnt;
    }

    if (leaders.length > 0) {
      richMostActive = { namesHtml: leaders, count: leaderCount };
      sectionsIncluded.push('mostActive');
    }
  }

  // Maps — EVERY map played this window, desc by match count (owner: «топ всех
  // карт», same shape as the ace/knife boards). maps[0] still drives the cover.
  {
    const maps = await db
      .select({
        map: matchRecords.map,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.map)
      // Alphabetical tie-break: equal-count maps otherwise come back in
      // whatever order the query plan produced, which also decided the cover.
      .orderBy(sql`COUNT(*) DESC`, matchRecords.map);

    topMap = maps[0]?.map != null ? String(maps[0].map) : null;

    if (maps.length > 0) {
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

  // Agents — EVERY agent picked this window, desc by pick count.
  {
    const agents = await db
      .select({
        agent: matchRecords.agent,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(matchRecords)
      .where(and(gte(matchRecords.started_at, weekStart), lt(matchRecords.started_at, weekEnd)))
      .groupBy(matchRecords.agent)
      .orderBy(sql`COUNT(*) DESC`, matchRecords.agent);

    topAgent = agents[0]?.agent != null ? String(agents[0].agent) : null;

    if (agents.length > 0) {
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
  // ONE render pass produces both the Rich Message html (what the group sees)
  // and the plain-text fallback (used only when sendRichMessage errors, and as
  // the promo-image prompt input). They come from the same block list, so a
  // section can never appear in one and not the other. `topMap` — the strongest
  // map of the week, already computed for the promo image — drives the cover.
  const { html: richHtml, text } = renderDigest({
    headerDate,
    coverMap: topMap,
    totalMatches,
    records: richRecords,
    winstreaks: richWinstreaks,
    aces: richAces,
    knives: richKnives,
    promotions: richPromotions,
    weaponMasters: richWeaponMasters,
    nearMisses: richNearMisses,
    mostActive: richMostActive,
    topMaps: richTopMaps,
    topAgents: richTopAgents,
  });

  return { text, richHtml, sectionsIncluded, topMap, topAgent };
}


function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
