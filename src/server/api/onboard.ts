import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Api } from 'grammy';
import { users } from '../db/schema/users.ts';
import { safePromote, safeSetCustomTitle } from '../lib/safe-telegram.ts';
import { formatRiotTitle } from '../lib/format-title.ts';
import {
  HenrikNotFoundError,
  HenrikRateLimitError,
  type RiotAccount,
} from '../lib/henrik.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const OnboardBodySchema = z.object({
  name: z.string().min(3).max(16),
  tag: z.string().min(3).max(5),
});

export interface OnboardHandlerDeps {
  db: AnyDb;
  validateAccount: (name: string, tag: string) => Promise<RiotAccount>;
  /**
   * Optional: initial backfill hook from henrik-scanner-loop (#9).
   * Will be wired once that issue lands. For now, pass `undefined`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scanForPuuid?: ((puuid: string, opts: { detection: boolean }) => Promise<any>) | undefined;
  botApi: Api | undefined;
  getAllowedChatIds: () => Set<number>;
}

/**
 * Factory: returns a Hono handler for POST /api/onboard.
 *
 * Steps:
 * 1. Validate request body (name, tag).
 * 2. Call Henrik API to resolve PUUID.
 * 3. Check for duplicate PUUID (belonging to a different telegram_id).
 * 4. UPSERT user row with riot data + onboarded_at.
 * 5. Apply fake-admin custom_title in each allowed chat.
 * 6. Fire-and-forget initial backfill scan (if scanForPuuid provided).
 * 7. Return 200 {success, profile, joinedGroup}.
 */
export function makeOnboardHandler(deps: OnboardHandlerDeps) {
  return async (c: Context) => {
    // 1. Parse body
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
    const telegramUser = c.get('telegramUser');
    const telegramId = telegramUser.id;

    // 2. Validate Riot account via Henrik
    let account: RiotAccount;
    try {
      account = await deps.validateAccount(name, tag);
    } catch (err) {
      if (err instanceof HenrikNotFoundError) {
        return c.json({ error: 'riot_id_not_found' }, 404);
      }
      if (err instanceof HenrikRateLimitError) {
        return c.json({ error: 'henrik_rate_limited', retryAfter: err.retryAfter }, 503);
      }
      logger.error({ module: 'onboard', err }, 'Henrik upstream error');
      return c.json({ error: 'henrik_unavailable' }, 502);
    }

    const { puuid } = account;

    // 3. Check for duplicate PUUID
    const existingRows = await deps.db
      .select({ telegram_id: users.telegram_id, telegram_username: users.telegram_username })
      .from(users)
      .where(eq(users.riot_puuid, puuid))
      .limit(1);

    const existing = existingRows[0] ?? null;
    if (existing && existing.telegram_id !== telegramId) {
      const otherUsername = existing.telegram_username
        ? `@${existing.telegram_username}`
        : `user#${existing.telegram_id}`;
      return c.json({ error: 'puuid_already_linked', other: otherUsername }, 409);
    }

    // 4. UPSERT user row
    const now = Date.now();
    await deps.db
      .insert(users)
      .values({
        telegram_id: telegramId,
        telegram_username: telegramUser.username ?? null,
        riot_puuid: puuid,
        riot_name: account.name,
        riot_tag: account.tag,
        riot_region: account.region,
        onboarded_at: now,
        joined_at: now,
      })
      .onConflictDoUpdate({
        target: users.telegram_id,
        set: {
          riot_puuid: puuid,
          riot_name: account.name,
          riot_tag: account.tag,
          riot_region: account.region,
          onboarded_at: now,
        },
      });

    // 5. Apply fake-admin custom_title in each allowed chat
    let joinedGroup = true;
    const title = formatRiotTitle(account.name, account.tag);

    if (deps.botApi) {
      const chatIds = Array.from(deps.getAllowedChatIds());

      for (const chatId of chatIds) {
        try {
          await safePromote(deps.botApi, chatId, telegramId, { can_manage_chat: true });
        } catch (err) {
          const errMessage = (err as Error).message ?? '';
          if (errMessage.includes('user_not_found') || errMessage.includes('USER_NOT_FOUND')) {
            logger.warn({ module: 'onboard', chatId, telegramId }, 'User not in group — skipping custom_title');
            joinedGroup = false;
            continue;
          }
          if (errMessage.includes('not_enough_rights') || errMessage.includes('CHAT_ADMIN_REQUIRED')) {
            logger.error({ module: 'onboard', chatId }, 'Bot lacks admin rights to promote');
            return c.json({ error: 'bot_lacks_admin_rights', chatId }, 500);
          }
          logger.warn({ module: 'onboard', chatId, err }, 'safePromote failed — skipping');
          continue;
        }

        try {
          await safeSetCustomTitle(deps.botApi, chatId, telegramId, title);
        } catch (err) {
          const errMessage = (err as Error).message ?? '';
          if (errMessage.includes('user_not_found') || errMessage.includes('USER_NOT_FOUND')) {
            logger.warn({ module: 'onboard', chatId, telegramId }, 'User not in group — custom_title skipped');
            joinedGroup = false;
          } else if (errMessage.includes('not_enough_rights') || errMessage.includes('CHAT_ADMIN_REQUIRED')) {
            logger.error({ module: 'onboard', chatId }, 'Bot lacks admin rights to set custom title');
            return c.json({ error: 'bot_lacks_admin_rights', chatId }, 500);
          } else {
            logger.warn({ module: 'onboard', chatId, err }, 'safeSetCustomTitle failed — skipping');
          }
        }
      }
    } else {
      logger.warn({ module: 'onboard' }, 'botApi not available — skipping custom_title');
    }

    // 6. Initial backfill (fire-and-forget, optional dep)
    if (deps.scanForPuuid) {
      deps.scanForPuuid(puuid, { detection: false }).catch((err) => {
        logger.warn({ module: 'onboard', puuid, err }, 'Initial backfill scan failed');
      });
    } else {
      logger.info({ module: 'onboard', puuid }, 'TODO: scanForPuuid not wired yet — wire in #9 (henrik-scanner-loop)');
    }

    // 7. Return success
    return c.json({
      success: true,
      profile: {
        name: account.name,
        tag: account.tag,
        puuid,
      },
      joinedGroup,
    });
  };
}
