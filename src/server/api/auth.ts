import type { Context, Next } from 'hono';
import type { TelegramUser } from '../lib/init-data.ts';

// Extend Hono's ContextVariableMap so c.get/c.set are type-safe
declare module 'hono' {
  interface ContextVariableMap {
    telegramUser: TelegramUser;
  }
}

export interface AuthMiddlewareDeps {
  verify: (raw: string) => TelegramUser;
}

/**
 * Factory: returns a Hono middleware that validates the Telegram initData
 * from the Authorization header (format: `tma <initDataRaw>`).
 *
 * On success, sets `c.var.telegramUser` for downstream handlers.
 * On failure, responds 401 { error: 'unauthorized' }.
 */
export function makeAuthMiddleware(deps: AuthMiddlewareDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('tma ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      const user = deps.verify(auth.slice(4));
      c.set('telegramUser', user);
    } catch {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
