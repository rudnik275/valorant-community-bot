/**
 * seed-rr-change.ts — one-off fill of `match_records.rr_change` / `rank_before`
 * from Henrik `/v2/by-puuid/mmr-history` (#388).
 *
 * The scanner fills `rr_change` only for a player's newest match per scan tick
 * (MMR v3 `latest_update`, #384), so rows written before that deploy — and any
 * second new match in one tick — stay null, and «🏦 RR недели» has nothing to
 * sum. mmr-history returns Riot's RR verdict for each player's last 20 ranked
 * matches; this walks every member once and writes the verdict onto the
 * matching (match_id, riot_puuid) row.
 *
 * Only rows whose `rr_change` is still null are touched — whatever the scanner
 * already wrote wins, and a second run is a no-op. A failed fetch is logged and
 * that member skipped; the run never aborts. Dry-run (`apply: false`) only
 * counts what it would write.
 *
 * Entry point for prod: scripts/launch/seed-rr-change.ts.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import type { HenrikMmrHistoryEntry } from '../lib/henrik.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SeedRrChangeOpts {
  /** Fetches one member's RR history (prod: `getMmrHistoryByPuuid`). */
  fetchHistory: (puuid: string, region: string) => Promise<HenrikMmrHistoryEntry[]>;
  /** Write the rows. False ⇒ dry-run: count candidates, write nothing. */
  apply: boolean;
  /** Progress / failure lines. Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Pause between members, ms. The Henrik key is shared with the live scanner;
   * the per-process token bucket in lib/henrik.ts already meters calls, this
   * just spreads them further. Tests pass 0.
   */
  pauseMs?: number;
}

export interface SeedRrChangeResult {
  /** Members with a PUUID and region — everyone the seed tried. */
  users: number;
  /** History entries that matched a row with a null `rr_change`. */
  candidates: number;
  /** Rows written (always 0 on a dry-run). */
  updated: number;
  /** Members whose history fetch failed. */
  skipped: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function seedRrChange(db: AnyDb, opts: SeedRrChangeOpts): Promise<SeedRrChangeResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const pauseMs = opts.pauseMs ?? 2000;

  const members = (await db
    .select({
      riot_puuid: users.riot_puuid,
      riot_region: users.riot_region,
      riot_name: users.riot_name,
      riot_tag: users.riot_tag,
    })
    .from(users)
    .where(and(isNotNull(users.riot_puuid), isNotNull(users.riot_region)))
    .orderBy(users.telegram_id)) as Array<{
    riot_puuid: string;
    riot_region: string;
    riot_name: string | null;
    riot_tag: string | null;
  }>;

  const result: SeedRrChangeResult = { users: members.length, candidates: 0, updated: 0, skipped: 0 };

  for (const [i, member] of members.entries()) {
    if (i > 0 && pauseMs > 0) await sleep(pauseMs);
    const who = `${member.riot_name ?? '?'}#${member.riot_tag ?? '?'}`;

    let history: HenrikMmrHistoryEntry[];
    try {
      history = await opts.fetchHistory(member.riot_puuid, member.riot_region);
    } catch (err) {
      result.skipped += 1;
      log(`  ${who}: SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let candidates = 0;
    let updated = 0;
    for (const entry of history) {
      // Nothing to write — Henrik had no verdict for this match.
      if (entry.last_change == null) continue;

      const target = and(
        eq(matchRecords.match_id, entry.match_id),
        eq(matchRecords.riot_puuid, member.riot_puuid),
        isNull(matchRecords.rr_change),
      );

      if (!opts.apply) {
        const [row] = await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(matchRecords)
          .where(target);
        candidates += Number(row?.n ?? 0);
        continue;
      }

      const tierBefore = entry.tier_before_update?.name ?? null;
      const written = await db
        .update(matchRecords)
        // Keep a `rank_before` the scanner already stored when Henrik's
        // history entry has no tier for this match.
        .set(tierBefore ? { rr_change: entry.last_change, rank_before: tierBefore } : { rr_change: entry.last_change })
        .where(target)
        .returning({ match_id: matchRecords.match_id });
      candidates += written.length;
      updated += written.length;
    }

    result.candidates += candidates;
    result.updated += updated;
    log(
      `  ${who}: ${history.length} history entries, ${candidates} null rows matched` +
        (opts.apply ? `, ${updated} written` : ''),
    );
  }

  return result;
}
