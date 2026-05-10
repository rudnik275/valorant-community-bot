import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import { users } from '../db/schema/users.ts';
import {
  validateAccount as defaultValidateAccount,
  HenrikNotFoundError,
  HenrikInactiveAccountError,
  HenrikRateLimitError,
  HenrikUpstreamError,
  type RiotAccount,
} from '../lib/henrik.ts';
import { scanForPuuid as defaultScanForPuuid } from '../scanner/index.ts';
import logger from '../lib/log.ts';
import { FULL_PERMISSIONS } from '../cron/restrict-grace.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface OnboardHandlerDeps {
  db: AnyDb;
  /** validateAccount injectable for testing; defaults to Henrik implementation */
  validateAccount?: (name: string, tag: string) => Promise<RiotAccount>;
  /** Fire-and-forget per-puuid scan, already bound to db. Injected for testing. */
  scanForPuuid?: (puuid: string, opts: { detection: boolean }) => Promise<unknown>;
  /**
   * Telegram Bot API: restrict a chat member.
   * Used to lift read-only restriction after successful onboard.
   */
  restrictChatMember?: (
    chatId: number,
    userId: number,
    permissions: typeof FULL_PERMISSIONS,
  ) => Promise<void>;
  /** Returns allowed Telegram chat IDs — used to lift restrictions after onboard. */
  getAllowedChatIds?: () => Set<number>;
}

const OnboardBodySchema = z.object({
  name: z.string().min(1).max(16),
  tag: z.string().min(1).max(5).regex(/^[a-zA-Z0-9]+$/, 'Tag must be alphanumeric'),
});

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

  return async (c: Context) => {
    const telegramUser = c.get('telegramUser');
    const telegramId: number = telegramUser.id;

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

    // Resolve PUUID via Henrik
    let account: RiotAccount;
    try {
      account = await validate(name, tag);
    } catch (err) {
      if (err instanceof HenrikInactiveAccountError) {
        return c.json(
          {
            error: 'account_inactive',
            message: 'Аккаунт найден, но Riot не показывает по нему свежих матчей. Сыграй один матч (можно Deathmatch) и попробуй снова — после игры всё подтянется.',
          },
          404,
        );
      }
      if (err instanceof HenrikNotFoundError) {
        return c.json(
          { error: 'account_not_found', message: 'Riot аккаунт не найден' },
          404,
        );
      }
      if (err instanceof HenrikRateLimitError) {
        return c.json({ error: 'rate_limited', retry_after: err.retryAfter }, 429);
      }
      if (err instanceof HenrikUpstreamError) {
        return c.json({ error: 'henrik_upstream' }, 502);
      }
      throw err;
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
    if (restrictChatMember && getAllowedChatIds) {
      const [currentRow] = await deps.db
        .select({ restricted_at: users.restricted_at })
        .from(users)
        .where(and(isNotNull(users.restricted_at), eq(users.telegram_id, telegramId)))
        .limit(1);

      if (currentRow) {
        const chatIds = getAllowedChatIds();
        let anyUnrestrictFailed = false;

        for (const chatId of chatIds) {
          try {
            await restrictChatMember(chatId, telegramId, FULL_PERMISSIONS);
          } catch (err) {
            logger.warn(
              { module: 'onboard', telegram_id: telegramId, chat_id: chatId, err },
              'Failed to unrestrict user in chat — will retry on next onboard',
            );
            anyUnrestrictFailed = true;
          }
        }

        if (!anyUnrestrictFailed) {
          await deps.db
            .update(users)
            .set({ restricted_at: null })
            .where(eq(users.telegram_id, telegramId));
          logger.info(
            { module: 'onboard', telegram_id: telegramId },
            'User restriction lifted after onboard',
          );
        }
      }
    }

    // Fire-and-forget backfill scan — don't await, return success immediately
    void scan(puuid, { detection: false }).catch((err) => {
      logger.warn({ module: 'onboard', puuid, err }, 'Backfill scan failed (non-fatal)');
    });

    return c.json({
      status: 'ok',
      riot_name,
      riot_tag,
      riot_puuid: puuid,
      riot_region,
    });
  };
}
