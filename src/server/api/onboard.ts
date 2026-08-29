import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import { OnboardBodySchema } from '../../shared/schemas/onboard.ts';
import { users } from '../db/schema/users.ts';
import {
  resolveAccount as defaultValidateAccount,
  HenrikError,
  HenrikNotFoundError,
  HenrikInactiveAccountError,
  type RiotAccount,
  type Priority,
} from '../lib/henrik.ts';
import { scanForPuuid as defaultScanForPuuid } from '../scanner/index.ts';
import logger from '../lib/log.ts';
import { ungateMember, type RestrictChatMember } from '../gate/member-gate.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface OnboardHandlerDeps {
  db: AnyDb;
  /** validateAccount injectable for testing; defaults to Henrik implementation */
  validateAccount?: (name: string, tag: string, opts?: { priority?: Priority }) => Promise<RiotAccount>;
  /** Per-puuid scan, already bound to db. Injected for testing. */
  scanForPuuid?: (puuid: string, opts: { detection: boolean; priority?: Priority }) => Promise<unknown>;
  /**
   * Telegram Bot API: restrict a chat member.
   * Used to lift read-only restriction after successful onboard.
   */
  restrictChatMember?: RestrictChatMember;
  /** Returns allowed Telegram chat IDs — used to lift restrictions after onboard. */
  getAllowedChatIds?: () => Set<number>;
  /**
   * Telegram Bot API `answerChatJoinRequestQuery` (Bot API 10.1, guard-bot flow).
   * Present only in production wiring; absent ⇒ the guard flow degrades to the
   * owner approving join requests by hand.
   */
  answerChatJoinRequestQuery?: (queryId: string, approve: boolean) => Promise<void>;
}

/**
 * Why a nick was accepted without a resolved PUUID.
 *
 * - `inactive` — Henrik answered and confirmed the account EXISTS, it just has
 *   no recent match data. The nick is verified.
 * - `henrik_unreachable` — Henrik never gave a verdict (429 / 5xx / network /
 *   timeout / malformed response). The nick is UNVERIFIED: we admitted on trust
 *   because refusing a real friend over someone else's downtime is the worse
 *   failure. `retry-pending-onboard` is what eventually settles these.
 */
export type PendingReason = 'inactive' | 'henrik_unreachable';

/**
 * Factory: returns a Hono handler for POST /api/onboard.
 *
 * Validates { name, tag } from the JSON body against Riot's naming rules,
 * resolves the PUUID via Henrik's account endpoint, persists the user row,
 * and kicks off a fire-and-forget backfill scan.
 */
export function makeOnboardHandler(deps: OnboardHandlerDeps) {
  const validate = deps.validateAccount ?? defaultValidateAccount;
  const scan = deps.scanForPuuid ?? ((puuid, opts) => defaultScanForPuuid(deps.db, puuid, opts));
  const restrictChatMember = deps.restrictChatMember;
  const getAllowedChatIds = deps.getAllowedChatIds;

  /**
   * Lift the read-only restriction if the user is currently restricted.
   * Called the moment a nick is entered — both on a successful link AND on the
   * pending path (inactive/stale account). Entering a nick is the criterion for
   * being a participant, so a still-unresolved account must not stay muted.
   * Clears restricted_at only when every chat unrestrict succeeds; otherwise the
   * next onboard call retries.
   */
  const liftRestrictionIfAny = async (telegramId: number): Promise<void> => {
    if (!restrictChatMember || !getAllowedChatIds) return;

    const [currentRow] = await deps.db
      .select({ restricted_at: users.restricted_at })
      .from(users)
      .where(and(isNotNull(users.restricted_at), eq(users.telegram_id, telegramId)))
      .limit(1);
    if (!currentRow) return;

    // The lifting itself lives next to the gating it undoes — see
    // gate/member-gate.ts. Onboard decides WHEN someone earns the right to
    // write back; it does not own what that means.
    await ungateMember(
      { db: deps.db, restrictChatMember },
      { chatIds: getAllowedChatIds(), userId: telegramId },
    );
  };

  /**
   * Guard-bot flow: approve the join request this Mini App session was opened
   * for, if any. Best-effort by design — a failure here must not turn a valid
   * nick into an error page. When it fails the request simply stays in Telegram's
   * pending queue and the owner can approve by hand, which is also exactly what
   * happens when the group is not configured for a guard bot at all.
   *
   * Called BEFORE the backfill scan on the success path: the scan makes
   * interactive Henrik calls and the lifetime of `chat_join_request_query_id` is
   * undocumented, so spending it on a scan would be a bad trade.
   */
  const admitIfJoinRequest = async (
    queryId: string | undefined,
    telegramId: number,
  ): Promise<void> => {
    if (!queryId || !deps.answerChatJoinRequestQuery) return;
    try {
      await deps.answerChatJoinRequestQuery(queryId, true);
      logger.info(
        { module: 'onboard', telegram_id: telegramId },
        'Join request approved after nick entry',
      );
    } catch (err) {
      logger.warn(
        { module: 'onboard', telegram_id: telegramId, err },
        'answerChatJoinRequestQuery failed — request left pending for manual approval',
      );
    }
  };

  return async (c: Context) => {
    const telegramUser = c.get('telegramUser');
    const telegramId: number = telegramUser.id;
    const joinQueryId = telegramUser.chat_join_request_query_id;

    // Parse + validate request body
    let body: z.infer<typeof OnboardBodySchema>;
    try {
      const raw: unknown = await c.req.json();
      const parsed = OnboardBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
      }
      body = parsed.data;
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }

    const { name, tag } = body;

    // Resolve PUUID via Henrik — onboard is user-facing, jump the queue.
    let account: RiotAccount;
    try {
      account = await validate(name, tag, { priority: 'interactive' });
    } catch (err) {
      // A definitive "no such account" is NOT a Henrik problem — it is a wrong
      // nick, and the only branch that refuses. Everything else below accepts.
      if (err instanceof HenrikNotFoundError) {
        return c.json(
          { error: 'account_not_found', message: 'Riot аккаунт не найден' },
          404,
        );
      }

      // Anything else from Henrik means Henrik failed to give us a verdict:
      // 429, 5xx, network, timeout, malformed body — all wrapped as HenrikError
      // (see lib/henrik.ts). Refusing entry over someone else's outage is the
      // worse failure, so we admit and settle it later via the retry cron.
      //
      // A non-Henrik error is OUR bug, not Henrik's — it must NOT buy entry.
      if (!(err instanceof HenrikError)) {
        throw err;
      }

      const reason: PendingReason = err instanceof HenrikInactiveAccountError
        ? 'inactive'
        : 'henrik_unreachable';

      // Save name+tag so the retry cron can auto-link once Henrik answers.
      // No puuid — the row presence with riot_name set is the «engaged» signal.
      await deps.db
        .insert(users)
        .values({ telegram_id: telegramId, riot_name: name, riot_tag: tag })
        .onConflictDoUpdate({
          target: users.telegram_id,
          set: { riot_name: name, riot_tag: tag },
        });
      logger.info(
        { module: 'onboard', telegramId, riot_name: name, riot_tag: tag, reason, err },
        'Saved pending onboard — will retry via cron',
      );

      // Entering a nick is enough to be a participant — lift read-only now even
      // though the account is still unresolved (won't stay muted waiting on Henrik).
      await liftRestrictionIfAny(telegramId);
      await admitIfJoinRequest(joinQueryId, telegramId);

      return c.json({
        status: 'ok',
        riot_name: name,
        riot_tag: tag,
        riot_puuid: null,
        riot_region: null,
        pending: true,
        pending_reason: reason,
      });
    }

    const { puuid, name: riot_name, tag: riot_tag, region: riot_region, cardId: riot_card_id } = account;
    const onboarded_at = Date.now();

    // Persist to DB (UPSERT keyed on telegram_id)
    try {
      await deps.db
        .insert(users)
        .values({
          telegram_id: telegramId,
          riot_puuid: puuid,
          riot_name,
          riot_tag,
          riot_region,
          riot_card_id,
          onboarded_at,
        })
        .onConflictDoUpdate({
          target: users.telegram_id,
          set: { riot_puuid: puuid, riot_name, riot_tag, riot_region, riot_card_id, onboarded_at },
        });
    } catch (err) {
      // SQLite UNIQUE constraint on riot_puuid — another Telegram account already linked
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        // Check whether the conflict is on riot_puuid (not telegram_id)
        const existing = await deps.db
          .select({ telegram_id: users.telegram_id })
          .from(users)
          .where(eq(users.riot_puuid, puuid))
          .limit(1);
        const owner = existing[0];
        if (owner && owner.telegram_id !== telegramId) {
          return c.json({ error: 'puuid_already_linked' }, 409);
        }
      }
      throw err;
    }

    logger.info(
      { module: 'onboard', telegramId, riot_name, riot_tag, riot_region, puuid },
      'User onboarded',
    );

    // Auto-unrestrict: if user was previously restricted, lift restriction now
    await liftRestrictionIfAny(telegramId);
    // Let them in before the scan — see admitIfJoinRequest on why order matters.
    await admitIfJoinRequest(joinQueryId, telegramId);

    // Await backfill scan with interactive priority — onboard is user-facing,
    // we want rank+matches populated before responding. Failures are non-fatal:
    // the cron scanner already prioritizes users with null mmr_fetched_at.
    try {
      await scan(puuid, { detection: false, priority: 'interactive' });
    } catch (err) {
      logger.warn({ module: 'onboard', puuid, err }, 'Backfill scan failed (non-fatal)');
    }

    return c.json({
      status: 'ok',
      riot_name,
      riot_tag,
      riot_puuid: puuid,
      riot_region,
    });
  };
}
