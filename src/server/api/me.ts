import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface MeHandlerDeps {
  db: AnyDb;
}

/**
 * Factory: returns a Hono handler for GET /api/me.
 *
 * Returns whether the current Telegram user has completed onboarding
 * (i.e., has a riot_puuid and onboarded_at set).
 */
export function makeMeHandler(deps: MeHandlerDeps) {
  return async (c: Context) => {
    const telegramUser = c.get('telegramUser');
    const telegramId = telegramUser.id;

    const rows = await deps.db
      .select({
        telegram_id: users.telegram_id,
        riot_name: users.riot_name,
        riot_tag: users.riot_tag,
        riot_puuid: users.riot_puuid,
        onboarded_at: users.onboarded_at,
        current_tier_id: users.current_tier_id,
        current_tier_name: users.current_tier_name,
        peak_tier_id: users.peak_tier_id,
        peak_tier_name: users.peak_tier_name,
        peak_season_short: users.peak_season_short,
        riot_region: users.riot_region,
      })
      .from(users)
      .where(eq(users.telegram_id, telegramId))
      .limit(1);

    const row = rows[0] ?? null;

    if (!row) {
      return c.json({ onboarded: false, profile: null });
    }

    const onboarded = row.riot_puuid !== null && row.onboarded_at !== null;

    return c.json({
      onboarded,
      profile: {
        telegramId: row.telegram_id,
        riotName: row.riot_name,
        riotTag: row.riot_tag,
        riotPuuid: row.riot_puuid,
        currentRank: row.current_tier_id !== null && row.current_tier_name !== null
          ? { tierId: row.current_tier_id, tierName: row.current_tier_name }
          : null,
        peakRank: row.peak_tier_id !== null && row.peak_tier_name !== null
          ? { tierId: row.peak_tier_id, tierName: row.peak_tier_name, seasonShort: row.peak_season_short }
          : null,
        region: row.riot_region,
      },
    });
  };
}
