/**
 * reconcile-membership.ts — Daily cron: purge departed players (verified via getChatMember).
 *
 * Croner '30 6 * * *' (06:30 daily) timezone Europe/Kyiv.
 * Does NOT collide with restrict-grace's '0 6 * * *' tick.
 *
 * Per tick:
 * 1. Load all members from users table.
 * 2. For each member (skip bot), for each allowed chat: call getChatMember.
 *    - PRESENT: status in {member, administrator, creator} or restricted+is_member=true.
 *    - DEPARTED: status in {left, kicked} or restricted+is_member=false.
 *    - UNKNOWN: call threw (per-call catch).
 * 3. Decision: KEEP if PRESENT in any chat. DEPARTED only if at least one call succeeded
 *    AND every successful call said DEPARTED. If all calls UNKNOWN → SKIP (never purge on
 *    inconclusive data).
 * 4. For each departed (unless dryRun): purgePlayer, then once rebuildRecords if any purged.
 */

import { Cron } from 'croner';
import { purgePlayer } from '../db/purge-player.ts';
import { users } from '../db/schema/users.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface ReconcileMembershipDeps {
  db: AnyDb;
  /** Returns the set of allowed Telegram chat IDs. */
  getAllowedChatIds: () => Set<number>;
  /** Bot's own Telegram user ID — always skipped. Evaluated lazily each tick. */
  getBotId: () => number;
  /** Telegram Bot API: get a single chat member's status. */
  getChatMember: (chatId: number, userId: number) => Promise<{ status: string; is_member?: boolean }>;
  /** Rebuild all derived records after a purge. */
  rebuildRecords: (db: AnyDb) => Promise<void>;
  /** When true: detect + log departures but do NOT purge or rebuild. */
  dryRun?: boolean;
}

export interface ReconcileResult {
  departed: number[];
  purged: number[];
}

type MembershipVerdict = 'present' | 'departed' | 'unknown';

function classifyStatus(status: string, is_member?: boolean): MembershipVerdict {
  if (status === 'member' || status === 'administrator' || status === 'creator') {
    return 'present';
  }
  if (status === 'restricted') {
    return is_member === true ? 'present' : 'departed';
  }
  if (status === 'left' || status === 'kicked') {
    return 'departed';
  }
  // Any other unrecognised status → treat as unknown
  return 'unknown';
}

export async function runReconcileMembershipTick(
  deps: ReconcileMembershipDeps,
): Promise<ReconcileResult> {
  const { db, getAllowedChatIds, getBotId, getChatMember, rebuildRecords, dryRun = false } = deps;
  const botId = getBotId();
  const chatIds = Array.from(getAllowedChatIds());

  // Load all members
  const allMembers: Array<{ telegram_id: number; riot_puuid: string | null }> = await db
    .select({ telegram_id: users.telegram_id, riot_puuid: users.riot_puuid })
    .from(users);

  let checkedCount = 0;
  let skippedUnknownCount = 0;
  const departedIds: number[] = [];

  for (const member of allMembers) {
    const { telegram_id, riot_puuid } = member;

    // Always skip the bot itself
    if (telegram_id === botId) continue;

    checkedCount++;

    // Check each chat
    let anyPresent = false;
    let anySucceeded = false;
    let allDeparted = true; // pessimistic until proven otherwise

    for (const chatId of chatIds) {
      let verdict: MembershipVerdict;
      try {
        const result = await getChatMember(chatId, telegram_id);
        verdict = classifyStatus(result.status, result.is_member);
        anySucceeded = true;
      } catch (err) {
        logger.warn(
          { module: 'reconcile-membership', chat_id: chatId, telegram_id, err },
          'getChatMember failed — skipping this chat result',
        );
        verdict = 'unknown';
      }

      if (verdict === 'present') {
        anyPresent = true;
        allDeparted = false;
        break; // No need to check more chats — member is confirmed present
      }
      if (verdict === 'unknown') {
        allDeparted = false; // Unknown is not a confirmed departure
      }
      // verdict === 'departed': allDeparted stays true, continue loop
    }

    // Safety guard: if no call succeeded, skip entirely
    if (!anySucceeded) {
      skippedUnknownCount++;
      logger.warn(
        { module: 'reconcile-membership', telegram_id },
        'All getChatMember calls failed — skipping member (inconclusive)',
      );
      continue;
    }

    // Member is DEPARTED if every successful call said departed AND no call said present
    if (!anyPresent && allDeparted) {
      departedIds.push(telegram_id);
      logger.info(
        { module: 'reconcile-membership', telegram_id, riot_puuid },
        'Member confirmed departed',
      );
    }
  }

  if (dryRun) {
    logger.info(
      {
        module: 'reconcile-membership',
        checked: checkedCount,
        departed: departedIds.length,
        skipped_unknown: skippedUnknownCount,
        dry_run: true,
      },
      'Dry-run complete — no deletions performed',
    );
    return { departed: departedIds, purged: [] };
  }

  // Purge each confirmed-departed member
  const purgedIds: number[] = [];
  for (const telegramId of departedIds) {
    const memberRow = allMembers.find((m) => m.telegram_id === telegramId);
    const riotPuuid = memberRow?.riot_puuid ?? null;
    try {
      await purgePlayer(db, { telegramId, riotPuuid });
      purgedIds.push(telegramId);
      logger.info(
        { module: 'reconcile-membership', telegram_id: telegramId, riot_puuid: riotPuuid },
        'Player purged',
      );
    } catch (err) {
      logger.error(
        { module: 'reconcile-membership', telegram_id: telegramId, err },
        'purgePlayer failed — skipping rebuild for this member',
      );
    }
  }

  // Rebuild derived records once if any purges happened
  if (purgedIds.length > 0) {
    try {
      await rebuildRecords(db);
      logger.info(
        { module: 'reconcile-membership', purged: purgedIds.length },
        'Records rebuilt after purge',
      );
    } catch (err) {
      logger.error(
        { module: 'reconcile-membership', err },
        'rebuildRecords failed after purge',
      );
    }
  }

  logger.info(
    {
      module: 'reconcile-membership',
      checked: checkedCount,
      departed: departedIds.length,
      purged: purgedIds.length,
      skipped_unknown: skippedUnknownCount,
    },
    'Reconcile membership tick complete',
  );

  return { departed: departedIds, purged: purgedIds };
}

export function startReconcileMembershipLoop(deps: ReconcileMembershipDeps): () => void {
  const cronJob = new Cron(
    '30 6 * * *',
    { timezone: 'Europe/Kyiv', protect: true },
    () => {
      void runReconcileMembershipTick(deps);
    },
  );

  logger.info(
    { module: 'reconcile-membership', cron: '30 6 * * *', tz: 'Europe/Kyiv' },
    'Reconcile-membership loop started',
  );

  return function stopReconcileMembershipLoop() {
    cronJob.stop();
    logger.info({ module: 'reconcile-membership' }, 'Reconcile-membership loop stopped');
  };
}
