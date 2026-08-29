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
 * - On HenrikNotFoundError → CLEAR riot_name/riot_tag and notify the user; this
 *   is the settling step for nicks that `onboard` admitted without a verdict
 *   while Henrik was down. restrict-grace re-gates the row on its next tick.
 * - On other errors (Henrik-side, no verdict) → log warn, no DB change.
 *
 * No notification to the user on success. No schema migration. No new columns.
 */

import { Cron } from 'croner';
import { isNull, isNotNull, and, eq } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import {
  type RiotAccount,
  HenrikInactiveAccountError,
  HenrikNotFoundError,
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
  /**
   * Best-effort notice to a user whose pending nick turned out not to exist and
   * was cleared. Optional — absent ⇒ the row is still cleared, just silently.
   */
  onNickCleared?: (telegramId: number, riotName: string, riotTag: string) => Promise<void>;
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

      if (err instanceof HenrikNotFoundError) {
        // Definitive verdict: this nick does not exist. Reachable now that
        // onboard admits on Henrik-side failures — such a row was never
        // verified, so it can hold pure typos (or junk typed during an outage).
        //
        // Clearing name+tag returns the row to «no nick», which is the state
        // restrict-grace already understands: it re-restricts on its next tick
        // and the user is back to entering a nick. Two existing crons compose;
        // no new column, no migration.
        //
        // ONLY on a definitive 404 — never on inactive or Henrik-side errors,
        // or an outage would wash out legitimate members.
        await db
          .update(users)
          .set({ riot_name: null, riot_tag: null })
          .where(eq(users.telegram_id, telegram_id));

        logger.warn(
          { module: 'retry-pending-onboard', telegram_id, riot_name, riot_tag },
          'Pending nick does not exist — cleared; restrict-grace will re-gate',
        );

        // Tell them why, or the re-restriction reads as the bot randomly
        // muting them hours after they were let in.
        if (deps.onNickCleared) {
          try {
            await deps.onNickCleared(telegram_id, riot_name, riot_tag);
          } catch (notifyErr) {
            logger.warn(
              { module: 'retry-pending-onboard', telegram_id, err: notifyErr },
              'Failed to notify user about cleared nick',
            );
          }
        }
        continue;
      }

      // Henrik-side failure (rate limit, upstream, network) — no verdict, so
      // the row must survive untouched and be retried tomorrow.
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
