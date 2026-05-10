import type { Context, Next } from 'hono';
import type { TelegramUser } from '../lib/init-data.ts';
import logger from '../lib/log.ts';

// Extend Hono's ContextVariableMap so c.get/c.set are type-safe
declare module 'hono' {
  interface ContextVariableMap {
    telegramUser: TelegramUser;
  }
}

export interface AuthMiddlewareDeps {
  verify: (raw: string) => TelegramUser;
  /**
   * Optional: fire-and-forget UPSERT called after each successful auth.
   * Failure is logged and swallowed — never blocks the request.
   */
  upsertUser?: (user: TelegramUser) => Promise<void>;
}

/**
 * Factory: returns a Hono middleware that validates the Telegram initData
 * from the Authorization header (format: `tma <initDataRaw>`).
 *
 * On success, sets `c.var.telegramUser` for downstream handlers and
 * fire-and-forgets an UPSERT via deps.upsertUser (if provided).
 * On failure, responds 401 { error: 'unauthorized' }.
 */
export function makeAuthMiddleware(deps: AuthMiddlewareDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('tma ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let user: TelegramUser;
    try {
      user = deps.verify(auth.slice(4));
      c.set('telegramUser', user);
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Fire-and-forget UPSERT — captures users who open the Mini App without
    // ever posting in the group. Failure is logged but must not block the request.
    if (deps.upsertUser) {
      deps.upsertUser(user).catch((err) => {
        logger.warn({ module: 'auth', err, telegram_id: user.id }, 'UPSERT user on auth failed');
      });
    }
    await next();
  };
}
