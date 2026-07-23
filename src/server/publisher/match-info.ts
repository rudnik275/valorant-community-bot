/**
 * match-info.ts — SHARED resolver for the per-match template context
 * (`TemplateMatch`) consumed by `renderTemplate`.
 *
 * Used by BOTH the realtime publisher loop (production posts) and the
 * `/test_runtime_events` owner replay. That sharing is the point: replay
 * parity (#315) is guaranteed by construction — whatever data production
 * resolves (map, match_id, the triggering player's agent + per-match rank,
 * teamkill victims enriched from the match roster), the replay resolves via
 * the exact same code path.
 *
 * Resolution sources:
 * - `match_records` (scoped by match_id + puuid): map, agent, rank_after —
 *   the triggering player's own record of this match.
 * - `match_rosters` via `getFullRoster` (teamkill only): victims' tag / agent /
 *   per-match rank (`tier`). Roster rows written before migration 0021 have
 *   NULL tier ⇒ the rank icon is simply omitted.
 *
 * Graceful degradation everywhere: missing rows / NULL columns / roster query
 * failures never throw out of the resolver — old events must still render.
 */

import { and, eq } from 'drizzle-orm';
import { matchRecords } from '../db/schema/match_records.ts';
import { getFullRoster, type FullRosterRow, type SqliteDb } from '../db/queries.ts';
import type { EventType } from './types.ts';
import type { TemplateMatch, TemplateVictim } from './templates.ts';
import logger from '../lib/log.ts';

/**
 * Resolve the `TemplateMatch` context for one detected event.
 * Returns `undefined` when there is nothing to attach (no match id and no
 * match_records row) — mirrors the historical loop behaviour.
 */
export async function resolveTemplateMatch(
  db: SqliteDb,
  eventType: EventType,
  rawMatchId: string | null | undefined,
  puuid: string,
  payload: Record<string, unknown>,
): Promise<TemplateMatch | undefined> {
  // record_kills_per_weapon stores a synthetic event match_id
  // (`<real_match_id>#kpw-<weapon>`) but keeps the real id in
  // payload.real_match_id — use that for the tracker link / lookups.
  const matchId =
    eventType === 'record_kills_per_weapon' && typeof payload['real_match_id'] === 'string'
      ? payload['real_match_id']
      : (rawMatchId || undefined);

  let matchRow:
    | { map: string | null; agent: string | null; rank_after: string | null }
    | undefined;
  if (matchId) {
    const rows = (await db
      .select({
        map: matchRecords.map,
        agent: matchRecords.agent,
        rank_after: matchRecords.rank_after,
      })
      .from(matchRecords)
      .where(
        and(
          eq(matchRecords.match_id, matchId),
          eq(matchRecords.riot_puuid, puuid),
        ),
      )
      .limit(1)) as Array<{ map: string | null; agent: string | null; rank_after: string | null }>;
    matchRow = rows[0];
  }

  const victims =
    eventType === 'teamkill' && matchId
      ? await resolveTeamkillVictims(db, matchId, payload)
      : undefined;

  if (!matchId && !matchRow) return undefined;

  return {
    ...(matchRow?.map ? { map: matchRow.map } : {}),
    ...(matchId ? { match_id: matchId } : {}),
    ...(matchRow?.agent ? { agent: matchRow.agent } : {}),
    ...(matchRow?.rank_after ? { rank: matchRow.rank_after } : {}),
    ...(victims && victims.length > 0 ? { victims } : {}),
  };
}

/**
 * Enrich the teamkill payload's victim list with tag / agent / per-match rank
 * from the match roster. Payload data wins when present (it was captured at
 * detection time); the roster fills the gaps — most importantly `tier`, which
 * is NOT in the payload at all.
 *
 * Handles both payload shapes:
 * - current: `victims: [{ puuid, name, tag, agent }]`
 * - legacy:  `victim_names_for_template: string[]` (matched to roster by name)
 *
 * Returns `undefined` when the payload names no victims. Roster lookup
 * failures degrade to payload-only data (no rank), never throw.
 */
async function resolveTeamkillVictims(
  db: SqliteDb,
  matchId: string,
  payload: Record<string, unknown>,
): Promise<TemplateVictim[] | undefined> {
  const raw: Array<{ puuid?: string; name?: string; tag?: string; agent?: string }> =
    Array.isArray(payload['victims'])
      ? (payload['victims'] as Array<{ puuid?: string; name?: string; tag?: string; agent?: string }>)
      : Array.isArray(payload['victim_names_for_template'])
        ? (payload['victim_names_for_template'] as unknown[])
            .filter((n): n is string => typeof n === 'string')
            .map((name) => ({ name }))
        : [];

  const named = raw.filter(
    (v) => typeof v.name === 'string' && v.name.length > 0,
  );
  if (named.length === 0) return undefined;

  const byPuuid = new Map<string, FullRosterRow>();
  const byName = new Map<string, FullRosterRow>();
  try {
    const roster = await getFullRoster(db, matchId);
    for (const r of roster) {
      byPuuid.set(r.riot_puuid, r);
      if (r.name && !byName.has(r.name)) byName.set(r.name, r);
    }
  } catch (err: unknown) {
    logger.warn(
      { module: 'publisher', match_id: matchId, err },
      'Teamkill victim roster lookup failed — rendering payload data only',
    );
  }

  return named.map((v) => {
    const rosterRow =
      (v.puuid ? byPuuid.get(v.puuid) : undefined) ??
      (v.name ? byName.get(v.name) : undefined);
    const tag = v.tag ?? rosterRow?.tag ?? undefined;
    const agent = v.agent ?? rosterRow?.agent ?? undefined;
    const rank = rosterRow?.tier ?? undefined;
    return {
      name: v.name!,
      ...(tag ? { tag } : {}),
      ...(agent ? { agent } : {}),
      ...(rank ? { rank } : {}),
    };
  });
}
