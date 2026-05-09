import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { optOuts } from '../db/schema/opt_outs.ts';
import logger from '../lib/log.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface SettingsHandlerDeps {
  db: AnyDb;
}

const PatchSettingsBodySchema = z.object({
  chatRealtimeDisabled: z.boolean(),
});

/**
 * Factory: returns Hono handlers for GET/PATCH /api/me/settings.
 *
 * GET: returns { chatRealtimeDisabled: boolean } — from opt_outs table.
 *      If no row exists, defaults to false.
 * PATCH: UPSERT opt_outs with the provided chatRealtimeDisabled value.
 *        Returns the updated value.
 */
export function makeSettingsHandlers(deps: SettingsHandlerDeps) {
  return {
    getSettings: async (c: Context) => {
      const telegramUser = c.get('telegramUser');
      const telegramId: number = telegramUser.id;

      const rows = await deps.db
        .select({ chat_realtime_disabled: optOuts.chat_realtime_disabled })
        .from(optOuts)
        .where(eq(optOuts.telegram_id, telegramId))
        .limit(1);

      const row = rows[0] ?? null;
      const chatRealtimeDisabled = row ? row.chat_realtime_disabled === 1 : false;

      return c.json({ chatRealtimeDisabled });
    },

    patchSettings: async (c: Context) => {
      const telegramUser = c.get('telegramUser');
      const telegramId: number = telegramUser.id;

      let body: z.infer<typeof PatchSettingsBodySchema>;
      try {
        const raw: unknown = await c.req.json();
        const parsed = PatchSettingsBodySchema.safeParse(raw);
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
        }
        body = parsed.data;
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }

      const { chatRealtimeDisabled } = body;
      const chat_realtime_disabled = chatRealtimeDisabled ? 1 : 0;
      const updated_at = Date.now();

      await deps.db
        .insert(optOuts)
        .values({ telegram_id: telegramId, chat_realtime_disabled, updated_at })
        .onConflictDoUpdate({
          target: optOuts.telegram_id,
          set: { chat_realtime_disabled, updated_at },
        });

      logger.info({ module: 'opt-out', telegramId, value: chatRealtimeDisabled }, 'opt-out updated');

      return c.json({ chatRealtimeDisabled });
    },
  };
}
