/**
 * match-codec.ts — Single source of truth for the compact match payload format.
 *
 * `match_records.kill_events_compact` and `match_records.rounds_compact` are
 * two JSON-string columns produced by the Scan tick (`scanner/derive.ts`) and
 * consumed by every detector + both digests.
 *
 * Before this module, derive.ts owned the encode shapes while SEVEN consumer
 * sites independently `JSON.parse`-d the blobs and re-declared their own
 * `KillEvent` / `RoundsCompactEntry` types with a hand-written cast and an
 * ad-hoc `try/catch → []` fallback. This module centralises:
 *
 *   - the canonical {@link KillEventCompact} / {@link RoundCompact} types,
 *   - {@link encodeKillEvents} / {@link encodeRounds} (used by derive.ts),
 *   - {@link decodeKillEvents} / {@link decodeRounds} (typed; the
 *     parse-failure → empty-array degradation lives here, in ONE place).
 *
 * HARD CONSTRAINT — the stored DB column string format MUST NOT change.
 * Match records are already persisted in prod and ADR-0003 is explicitly
 * going-forward-only with no backfill. This module centralises the
 * *in-process parse + typing*, not the wire format: `encode*` is exactly
 * `JSON.stringify` of the same shapes derive.ts already wrote, and `decode*`
 * is exactly `JSON.parse` of the same shapes consumers already cast to.
 */

/**
 * One row of `kill_events_compact`.
 *
 * The `victim_name?` / `victim_tag?` fields are the v3-vs-v4 Henrik skew:
 * they are NOT present in v3-derived blobs and only appear in v4-derived
 * blobs when Henrik supplies them. The ace detector relies on them for
 * display / opponent-peak names and tolerates their absence (see ADR-0003,
 * `ace.ts`). They MUST stay optional on this type.
 */
export interface KillEventCompact {
  round: number;
  attacker_team: string;
  victim_team: string;
  weapon: string;
  attacker_puuid: string;
  victim_puuid: string;
  /** Optional — absent in v3 kill_events_compact; present in v4 when available. */
  victim_name?: string;
  /** Optional — absent in v3 kill_events_compact; present in v4 when available. */
  victim_tag?: string;
}

/**
 * One row of `rounds_compact`.
 *
 * `w` (winning team id) is written by derive.ts for every emitted round
 * (rounds without a `winning_team` are filtered out before encode), but is
 * typed optional because historic/partial blobs and the parse-failure path
 * must not crash consumers that defensively check `if (r.w)`.
 *
 * `c` (Henrik's `rounds[].ceremony`, e.g. `"CeremonyAce"`) is optional and
 * only emitted when present. Per ADR-0003 it is NO LONGER consulted for ace
 * detection, but the field is preserved on the wire format going forward.
 */
export interface RoundCompact {
  r: number;
  w?: string;
  c?: string;
}

/**
 * Encode kill events into the `kill_events_compact` column string.
 * Used by `scanner/derive.ts`. Format is plain `JSON.stringify` — unchanged.
 */
export function encodeKillEvents(events: KillEventCompact[]): string {
  return JSON.stringify(events);
}

/**
 * Encode rounds into the `rounds_compact` column string.
 * Used by `scanner/derive.ts`. Format is plain `JSON.stringify` — unchanged.
 */
export function encodeRounds(rounds: RoundCompact[]): string {
  return JSON.stringify(rounds);
}

/**
 * Decode the `kill_events_compact` column into typed kill events.
 *
 * Degradation contract (single source): a null/empty/malformed blob — or one
 * that does not parse to a JSON array — yields `[]`. Consumers never see a
 * raw string and never re-implement the `try/catch`.
 */
export function decodeKillEvents(raw: string | null | undefined): KillEventCompact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KillEventCompact[]) : [];
  } catch {
    return [];
  }
}

/**
 * Decode the `rounds_compact` column into typed rounds.
 *
 * Same degradation contract as {@link decodeKillEvents}: null/empty/malformed
 * or non-array input yields `[]`.
 */
export function decodeRounds(raw: string | null | undefined): RoundCompact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RoundCompact[]) : [];
  } catch {
    return [];
  }
}

// ─── per_round_afk_compact ──────────────────────────────────────────────────
//
// New as of the AFK-knife-kill feature: per match, the set of player puuids
// that Riot flagged `was_afk` per round. Stored as an object keyed by round
// number → array of puuids. Rounds with no AFK player are omitted, so an
// empty map encodes to `"{}"` (or null in DB if we want to skip the write).
// Encoded shape is a flat JSON object, so any new sibling field can be added
// later (e.g. `stayed_in_spawn`) without breaking the column's wire format.

/** Encode a per-round AFK map. Empty map → `"{}"`. */
export function encodePerRoundAfk(map: Map<number, Set<string>>): string {
  const obj: Record<string, string[]> = {};
  for (const [round, puuids] of map) {
    if (puuids.size === 0) continue;
    obj[String(round)] = [...puuids];
  }
  return JSON.stringify(obj);
}

/**
 * Decode the `per_round_afk_compact` column.
 *
 * Same degradation contract as the other decoders: null / empty / malformed
 * / wrong-shape → empty map. Callers do `map.get(round)?.has(puuid)`.
 */
export function decodePerRoundAfk(raw: string | null | undefined): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const round = Number(k);
      if (!Number.isFinite(round)) continue;
      if (!Array.isArray(v)) continue;
      const puuids = (v as unknown[]).filter((p): p is string => typeof p === 'string');
      if (puuids.length > 0) out.set(round, new Set(puuids));
    }
    return out;
  } catch {
    return out;
  }
}
