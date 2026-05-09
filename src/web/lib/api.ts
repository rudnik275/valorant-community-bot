import type { z } from 'zod';

// Access Telegram WebApp initData, if available (inside Telegram) or empty string (dev).
// Strip C0 control chars (\r, \n, etc.) — WebKit/iOS sometimes appends trailing
// whitespace and HTTP header values must be ASCII printable per RFC 7230.
function getInitDataRaw(): string {
  if (typeof window === 'undefined') return '';
  const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  const raw = tg?.WebApp?.initData ?? '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
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
