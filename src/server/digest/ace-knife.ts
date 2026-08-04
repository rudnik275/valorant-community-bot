/**
 * ace-knife.ts — Weekly ace / knife LEADERBOARDS («кто сколько эйсов сделал,
 * кто сколько ножей сделал»).
 *
 * Replaces the whole `digest-daily` module (owner, 2026-08-04). Aces and knife
 * kills used to be batched into a 23:00 daily post that listed every single
 * occurrence — one row per round, with the round number, 🏆/💀 outcome and a
 * match link. That detail is GONE on purpose: the weekly digest now shows only
 * a per-player count, sorted desc.
 *
 * Counting rules:
 *   - Ace   — one per ACED ROUND. The detector emits one event per match with a
 *             `rounds` array (a player can ace at most once per round, so the
 *             array is already unique); the player's weekly total is the sum of
 *             those array lengths across the window.
 *   - Knife — one per KNIFE KILL, not per round. `payload.rounds` has one entry
 *             per kill and CAN repeat a round (two knife kills in one round =
 *             2). The old daily post deduped rounds; a leaderboard of "кто
 *             сколько ножей сделал" is more naturally kills.
 *   - 🪿    — subset of a player's knife kills whose victim Riot flagged
 *             `was_afk` that round («распотрошил гуся»). Rendered as a
 *             parenthetical, never as a separate leaderboard.
 *
 * Window / status semantics match the weekly bright-events query in build.ts:
 * events are selected by `detected_at` in [weekStart, weekEnd) and by type
 * only — NOT by `status`. Ace/knife rows are inserted 'digest-only' since the
 * category flip, but historical rows carry 'posted' / 'silent' from the daily
 * era and still count: the ace happened either way.
 *
 * Opted-out players are dropped, mirroring how bright events treat them.
 */

import { and, gte, lt, inArray, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

/** One player's row in an ace or knife leaderboard. */
export interface AceKnifeStanding {
  /** Riot display name (unescaped). */
  name: string;
  /** Riot tag (unescaped). */
  tag: string;
  /** Aces (aced rounds) or knife kills in the window. Always ≥ 1. */
  count: number;
  /**
   * Knife boards only: how many of `count` were kills on an AFK victim (🪿).
   * Always 0 on the ace board, and 0 on knife rows with no AFK victims.
   */
  geese: number;
}

export interface AceKnifeStandings {
  /** Ace leaderboard, desc by count. Empty ⇒ section omitted. */
  aces: AceKnifeStanding[];
  /** Knife leaderboard, desc by count. Empty ⇒ section omitted. */
  knives: AceKnifeStanding[];
}

interface Row {
  eventType: 'ace' | 'knife_kill';
  puuid: string;
  payloadJson: string;
  riotName: string | null;
  riotTag: string | null;
  telegramId: number | null;
}

interface Tally {
  name: string;
  tag: string;
  count: number;
  geese: number;
}

/**
 * Parse one event payload into `{ occurrences, geese }`.
 *
 * `rounds` is the authoritative array for both types (one entry per ace round /
 * per knife kill). Legacy rows that predate it fall back to the scalar counters
 * the detectors also write (`total_aces` / `count`); a row with neither
 * contributes nothing rather than throwing.
 */
function readOccurrences(
  eventType: 'ace' | 'knife_kill',
  payloadJson: string,
): { occurrences: number; geese: number } {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return { occurrences: 0, geese: 0 };
  }

  const rounds = Array.isArray(payload['rounds'])
    ? (payload['rounds'] as unknown[]).filter((r) => typeof r === 'number')
    : null;

  const fallbackKey = eventType === 'ace' ? 'total_aces' : 'count';
  const fallback = Number(payload[fallbackKey]);
  const occurrences = rounds !== null
    ? rounds.length
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : 0;

  if (eventType === 'ace' || occurrences === 0) {
    return { occurrences, geese: 0 };
  }

  // `victims_afk` is parallel to the RAW `rounds` array (one flag per kill).
  // Count only as many flags as we counted kills, so a malformed longer array
  // can never inflate the goose count past the kill count.
  const afkRaw = Array.isArray(payload['victims_afk']) ? (payload['victims_afk'] as unknown[]) : [];
  let geese = 0;
  for (let i = 0; i < Math.min(afkRaw.length, occurrences); i++) {
    if (afkRaw[i] === true) geese++;
  }
  return { occurrences, geese };
}

/** Sort desc by count, then by 🪿 desc, then by name for a stable order. */
function toStandings(tallies: Map<string, Tally>): AceKnifeStanding[] {
  return [...tallies.values()]
    .filter((t) => t.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.geese - a.geese ||
        `${a.name}#${a.tag}`.localeCompare(`${b.name}#${b.tag}`),
    )
    .map((t) => ({ name: t.name, tag: t.tag, count: t.count, geese: t.geese }));
}

/**
 * Build the weekly ace / knife leaderboards for [weekStart, weekEnd).
 *
 * `optedOutTelegramIds` are dropped from both boards. Players with no matching
 * `users` row are dropped too — a leaderboard entry needs a nick to render.
 */
export async function buildAceKnifeStandings(
  db: AnyDb,
  weekStart: number,
  weekEnd: number,
  optedOutTelegramIds: Set<number>,
): Promise<AceKnifeStandings> {
  const rows: Row[] = await db
    .select({
      eventType: detectedEvents.event_type,
      puuid: detectedEvents.riot_puuid,
      payloadJson: detectedEvents.payload_json,
      riotName: users.riot_name,
      riotTag: users.riot_tag,
      telegramId: users.telegram_id,
    })
    .from(detectedEvents)
    .leftJoin(users, eq(users.riot_puuid, detectedEvents.riot_puuid))
    .where(
      and(
        inArray(detectedEvents.event_type, ['ace', 'knife_kill']),
        gte(detectedEvents.detected_at, weekStart),
        lt(detectedEvents.detected_at, weekEnd),
      ),
    )
    .orderBy(detectedEvents.detected_at);

  const aceTallies = new Map<string, Tally>();
  const knifeTallies = new Map<string, Tally>();

  for (const row of rows) {
    // No nick ⇒ nothing to render. No telegram_id ⇒ can't be opted out.
    if (row.riotName === null) continue;
    if (row.telegramId !== null && optedOutTelegramIds.has(row.telegramId)) continue;

    const { occurrences, geese } = readOccurrences(row.eventType, row.payloadJson);
    if (occurrences === 0) continue;

    const bucket = row.eventType === 'ace' ? aceTallies : knifeTallies;
    const existing = bucket.get(row.puuid);
    if (existing) {
      existing.count += occurrences;
      existing.geese += geese;
    } else {
      bucket.set(row.puuid, {
        name: row.riotName,
        tag: row.riotTag ?? '',
        count: occurrences,
        geese,
      });
    }
  }

  return { aces: toStandings(aceTallies), knives: toStandings(knifeTallies) };
}
