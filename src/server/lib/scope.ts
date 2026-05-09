import { z } from 'zod';

const allowedChatIdsSchema = z.string().regex(/^-?\d+(,-?\d+)*$/, {
  message:
    'TELEGRAM_ALLOWED_CHAT_IDS must be a comma-separated list of integers (e.g. "-100123,-100456")',
});

let cachedSet: Set<number> | undefined;

export function loadAllowedChatIds(): Set<number> {
  const raw = process.env['TELEGRAM_ALLOWED_CHAT_IDS'];

  if (!raw || raw.trim() === '') {
    throw new Error(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set or empty. Set it to a comma-separated list of allowed chat IDs.',
    );
  }

  const parsed = allowedChatIdsSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new Error(
      `Invalid TELEGRAM_ALLOWED_CHAT_IDS: ${parsed.error.errors[0]?.message ?? 'unknown error'}`,
    );
  }

  return new Set(parsed.data.split(',').map(Number));
}

export function isAllowedChat(id: number): boolean {
  if (!cachedSet) {
    cachedSet = loadAllowedChatIds();
  }
  return cachedSet.has(id);
}

/** Reset the internal cache — used in tests to isolate env changes. */
export function _resetCache(): void {
  cachedSet = undefined;
}
