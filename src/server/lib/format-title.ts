/**
 * format-title.ts — Riot ID title formatter for Telegram custom_title.
 *
 * Telegram enforces a 16-character limit on custom titles (custom_title).
 * This helper truncates the name portion to fit within that limit while
 * always preserving the full `#TAG`.
 */

export function formatRiotTitle(name: string, tag: string): string {
  const full = `${name}#${tag}`;
  if (full.length <= 16) return full;
  const tail = `#${tag}`;
  return name.slice(0, 16 - tail.length) + tail;
}
