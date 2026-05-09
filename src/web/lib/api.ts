import type { z } from 'zod';

// Access Telegram WebApp initData, if available (inside Telegram) or empty string (dev)
function getInitDataRaw(): string {
  if (typeof window === 'undefined') return '';
  const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return tg?.WebApp?.initData ?? '';
}

/**
 * Typed fetch wrapper that adds Telegram initData auth header and
 * validates the response through the provided Zod schema.
 */
export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  opts?: RequestInit,
): Promise<T> {
  const initDataRaw = getInitDataRaw();
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts?.headers as Record<string, string> | undefined),
      Authorization: `tma ${initDataRaw}`,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status}`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}
