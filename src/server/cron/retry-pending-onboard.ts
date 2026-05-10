/**
 * retry-pending-onboard.ts — Daily cron: retry Henrik for pending (name+tag, no puuid) users.
 *
 * Croner '0 4 * * *' (04:00 daily) timezone Europe/Kyiv.
 *
 * Selects users where riot_name IS NOT NULL AND riot_tag IS NOT NULL AND riot_puuid IS NULL.
 * These are users who attempted to link but got code:24 (account inactive / no recent matches).
 *
 * Per user:
 * - Call validateAccount(riot_name, riot_tag).
 * - On success → UPDATE riot_puuid, riot_region, riot_name, riot_tag from canonical Henrik
 *   response. Fire-and-forget scanForPuuid.
 * - On HenrikInactiveAccountError → no-op, will retry tomorrow.
 * - On other errors → log warn, no DB change.
 *
 * No notification to the user on success. No schema migration. No new columns.
 */

import { Cron } from 'croner';
import { isNull, isNotNull, and, eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import {
  type RiotAccount,
  HenrikInactiveAccountError,
} from '../lib/henrik.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface RetryPendingOnboardDeps {
  db: AnyDb;
  /** Henrik account resolver. Injectable for testing. */
  validateAccount: (name: string, tag: string) => Promise<RiotAccount>;
  /** Fire-and-forget per-puuid scan, already bound to db. Injectable for testing. */
  scanForPuuid: (puuid: string, opts: { detection: boolean }) => Promise<unknown>;
}

export async function runRetryPendingOnboardTick(deps: RetryPendingOnboardDeps): Promise<void> {
  const { db, validateAccount, scanForPuuid } = deps;

  // Find users with name+tag but no puuid — they attempted to link but got code:24
  const pendingUsers: Array<{ telegram_id: number; riot_name: string; riot_tag: string }> =
    await db
      .select({
        telegram_id: users.telegram_id,
        riot_name: users.riot_name,
        riot_tag: users.riot_tag,
      })
      .from(users)
      .where(
        and(
          isNotNull(users.riot_name),
          isNotNull(users.riot_tag),
          isNull(users.riot_puuid),
        ),
      );

  if (pendingUsers.length === 0) {
    logger.info({ module: 'retry-pending-onboard' }, 'No pending users to retry this tick');
    return;
  }

  logger.info(
    { module: 'retry-pending-onboard', count: pendingUsers.length },
    'Retrying Henrik for pending users',
  );

  for (const row of pendingUsers) {
    const { telegram_id, riot_name, riot_tag } = row;

    let account: RiotAccount;
    try {
      account = await validateAccount(riot_name, riot_tag);
    } catch (err) {
      if (err instanceof HenrikInactiveAccountError) {
        // Still inactive — no-op, will retry tomorrow
        logger.info(
          { module: 'retry-pending-onboard', telegram_id, riot_name, riot_tag },
          'Account still inactive — will retry tomorrow',
        );
        continue;
      }
      // Any other error (not found, rate limit, upstream) — log and skip
      logger.warn(
        { module: 'retry-pending-onboard', telegram_id, riot_name, riot_tag, err },
        'validateAccount failed — skipping user',
      );
      continue;
    }

    // Success — update puuid + canonical name/tag/region
    await db
      .update(users)
      .set({
        riot_puuid: account.puuid,
        riot_name: account.name,
        riot_tag: account.tag,
        riot_region: account.region,
      })
      .where(eq(users.telegram_id, telegram_id));

    logger.info(
      { module: 'retry-pending-onboard', telegram_id, riot_name: account.name, riot_tag: account.tag, puuid: account.puuid },
      'Pending user linked — puuid resolved',
    );

    // Fire-and-forget backfill scan
    void scanForPuuid(account.puuid, { detection: false }).catch((err) => {
      logger.warn(
        { module: 'retry-pending-onboard', telegram_id, puuid: account.puuid, err },
        'Backfill scan failed (non-fatal)',
      );
    });
  }
}

export function startRetryPendingOnboardLoop(deps: RetryPendingOnboardDeps): () => void {
  const cronJob = new Cron(
    '0 4 * * *',
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runRetryPendingOnboardTick(deps);
    },
  );

  logger.info(
    { module: 'retry-pending-onboard', cron: '0 4 * * *', tz: 'Europe/Kyiv' },
    'Retry-pending-onboard loop started',
  );

  return function stopRetryPendingOnboardLoop() {
    cronJob.stop();
    logger.info({ module: 'retry-pending-onboard' }, 'Retry-pending-onboard loop stopped');
  };
}
