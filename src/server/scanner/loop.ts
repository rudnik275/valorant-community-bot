/**
 * loop.ts — Croner-based periodic scan loop.
 *
 * Runs every 30 minutes (at :00 and :30). On startup, waits 60 seconds before
 * the first tick to allow the server to warm up.
 *
 * Each tick:
 *   1. SELECT all users with riot_puuid IS NOT NULL.
 *   2. For each user, call scanForPuuid with { detection: true }.
 *   3. Sleep 2s between users to avoid hammering Henrik.
 *   4. Emit 'newRecord' events (handled by scanForPuuid internally).
 *   5. Log summary metrics.
 *   6. Ping HEALTHCHECK_SCANNER_URL if set (fire-and-forget).
 */

import { Cron } from 'croner';
import { isNotNull } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import { scannerEvents } from './events.ts';
import { scanForPuuid as defaultScanForPuuid, type ScanResult } from './scan.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartScanLoopOpts {
  db: AnyDb;
  /** Injectable for testing. Defaults to the real scanForPuuid bound to db. */
  scanForPuuid?: (puuid: string, opts: { detection: boolean }) => Promise<ScanResult>;
  /** Optional Healthchecks.io URL. Overrides process.env.HEALTHCHECK_SCANNER_URL. */
  healthcheckUrl?: string;
  /** Override cron expression for tests (e.g. fire immediately). */
  intervalCron?: string;
}

/** Returns a stop function for graceful shutdown. */
export function startScanLoop(opts: StartScanLoopOpts): () => void {
  const { db } = opts;
  const scan = opts.scanForPuuid ?? ((puuid, scanOpts) => defaultScanForPuuid(db, puuid, scanOpts));
  const cronExpr = opts.intervalCron ?? '*/30 * * * *';
  const healthcheckUrl = opts.healthcheckUrl ?? process.env['HEALTHCHECK_SCANNER_URL'];

  async function runTick(): Promise<void> {
    const tick_started_at = Date.now();

    // Fetch all onboarded users
    const allUsers = await db
      .select({ riot_puuid: users.riot_puuid })
      .from(users)
      .where(isNotNull(users.riot_puuid));

    let total_new_records = 0;
    let total_henrik_calls = 0;

    for (let i = 0; i < allUsers.length; i++) {
      const user = allUsers[i] as { riot_puuid: string };
      if (!user.riot_puuid) continue;

      try {
        const result = await scan(user.riot_puuid, { detection: true });
        total_new_records += result.newRecords.length;
        total_henrik_calls += 1;
      } catch (err) {
        logger.warn({ module: 'scanner-loop', puuid: user.riot_puuid, err }, 'scan tick: unexpected error for user');
      }

      // Sleep between users to avoid hammering Henrik API
      if (i < allUsers.length - 1) {
        await sleep(2000);
      }
    }

    const tick_ended_at = Date.now();

    logger.info(
      {
        module: 'scanner',
        tick_started_at,
        tick_ended_at,
        total_users: allUsers.length,
        total_new_records,
        total_henrik_calls,
        duration_ms: tick_ended_at - tick_started_at,
      },
      'scan tick complete',
    );

    // Healthcheck ping (fire-and-forget)
    if (healthcheckUrl) {
      globalThis.fetch(healthcheckUrl).catch((err) => {
        logger.warn({ module: 'scanner-loop', err }, 'Healthcheck ping failed');
      });
    }
  }

  // 60s warm-up delay before first tick, then start cron
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cronJob: { stop: () => void } | null = null;

  const warmUpTimer = setTimeout(() => {
    // Run first tick immediately after warm-up
    void runTick();

    // Then schedule recurring cron
    cronJob = new Cron(cronExpr, { protect: true }, () => {
      void runTick();
    });

    logger.info({ module: 'scanner-loop', cron: cronExpr }, 'scanner cron started');
  }, 60_000);

  // Return stop function
  return function stopScanLoop() {
    clearTimeout(warmUpTimer);
    cronJob?.stop();
    logger.info({ module: 'scanner-loop' }, 'scanner loop stopped');
  };
}

// Re-export events for convenience
export { scannerEvents };
