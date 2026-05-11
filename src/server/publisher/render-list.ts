/**
 * Render a list of items in a "single inline OR multi-line bulleted" style:
 * - 0 items: returns ''
 * - 1 item: returns the item as-is (caller should embed inline in caption)
 * - >1 items: prefix each with `• ` and join with `\n`
 *
 * Useful in digest sections that aggregate multiple players under one heading.
 * E.g.:
 *   const items = ['Ник — 12 побед подряд', 'Ник2 — 10'];
 *   const body = renderList(items);
 *   // 1 item → 'Ник — 12 побед подряд'
 *   // 2 items → '• Ник — 12 побед подряд\n• Ник2 — 10'
 */
export function renderList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return items.map((i) => `• ${i}`).join('\n');
}
