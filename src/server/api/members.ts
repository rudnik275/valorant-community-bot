import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { MembersResponseSchema } from '../../shared/schemas/members.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const AVATAR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface MembersHandlerDeps {
  db: AnyDb;
  refreshAvatarIfStale?: ((telegramId: number) => void) | undefined;
}

/**
 * Factory: returns a Hono handler for GET /api/members.
 *
 * Returns all registered users sorted by last_message_at DESC NULLS LAST,
 * joined_at ASC. Fires-and-forgets avatar refresh for stale entries (>24h or never fetched).
 */
export function makeMembersHandler(deps: MembersHandlerDeps) {
  return async (c: Context) => {
    const rows = await deps.db.all(sql`
      SELECT
        u.telegram_id,
        u.telegram_username,
        u.telegram_avatar_url,
        u.telegram_avatar_fetched_at,
        u.riot_name,
        u.riot_tag,
        u.riot_puuid,
        u.last_message_at,
        u.joined_at,
        u.current_tier_id,
        u.current_tier_name,
        u.peak_tier_id,
        u.peak_tier_name,
        u.peak_season_short
      FROM users u
      ORDER BY u.last_message_at DESC NULLS LAST, u.joined_at ASC
    `);

    const now = Date.now();

    type UserRow = {
      telegram_id: number;
      telegram_username: string | null;
      telegram_avatar_url: string | null;
      telegram_avatar_fetched_at: number | null;
      riot_name: string | null;
      riot_tag: string | null;
      riot_puuid: string | null;
      last_message_at: number | null;
      joined_at: number;
      current_tier_id: number | null;
      current_tier_name: string | null;
      peak_tier_id: number | null;
      peak_tier_name: string | null;
      peak_season_short: string | null;
    };

    const members = rows.map((row: UserRow) => {
      // Fire-and-forget avatar refresh if stale
      if (deps.refreshAvatarIfStale) {
        const fetchedAt = row.telegram_avatar_fetched_at;
        const isStale = fetchedAt === null || now - fetchedAt >= AVATAR_STALE_MS;
        if (isStale) {
          deps.refreshAvatarIfStale(row.telegram_id);
        }
      }

      return {
        telegramId: row.telegram_id,
        telegramUsername: row.telegram_username,
        telegramAvatarUrl: row.telegram_avatar_url,
        riotName: row.riot_puuid ? row.riot_name : null,
        riotTag: row.riot_puuid ? row.riot_tag : null,
        currentTierId: row.riot_puuid ? row.current_tier_id : null,
        currentTierName: row.riot_puuid ? row.current_tier_name : null,
        peakTierId: row.riot_puuid ? row.peak_tier_id : null,
        peakTierName: row.riot_puuid ? row.peak_tier_name : null,
        peakSeasonShort: row.riot_puuid ? row.peak_season_short : null,
        lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      };
    });

    const validated = MembersResponseSchema.parse(members);
    return c.json(validated);
  };
}
