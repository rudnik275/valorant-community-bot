/**
 * valorant-seasons.ts — hardcoded act/episode start timestamps.
 *
 * Update manually each new act (roughly every 2-3 months).
 * Used by rank_promo detector to skip cross-season rank comparisons.
 */

// Episode 9 Act 2 started ~2026-04-01. Update when next act launches.
export const CURRENT_ACT_START = Date.parse('2026-04-01T00:00:00Z');

export function getCurrentActStart(): number {
  return CURRENT_ACT_START;
}
