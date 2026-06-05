/**
 * Custom-emoji IDs for Valorant rank icons, keyed by competitive tier number.
 * Pack: https://t.me/addemoji/valorant_npc_by_valorant_comunity_bot — the group's
 * single designated emoji pack (see scripts/launch/build-emoji-pack.ts for why one).
 * Generated 2026-06-05 from valorant-api.com via scripts/launch/build-emoji-pack.ts.
 */
export const RANK_EMOJI: Record<number, { id: string; fallback: string }> = {
  0:  { id: '5265026152753303706', fallback: '❓' }, // Unranked
  3:  { id: '5265134957159815781', fallback: '🪨' }, // Iron 1
  4:  { id: '5267292688599785735', fallback: '🪨' }, // Iron 2
  5:  { id: '5267158286188189569', fallback: '🪨' }, // Iron 3
  6:  { id: '5264800271833275737', fallback: '🥉' }, // Bronze 1
  7:  { id: '5267421859741209656', fallback: '🥉' }, // Bronze 2
  8:  { id: '5264736972605264895', fallback: '🥉' }, // Bronze 3
  9:  { id: '5267074289512781103', fallback: '🥈' }, // Silver 1
  10: { id: '5267098672042126310', fallback: '🥈' }, // Silver 2
  11: { id: '5267238679386035982', fallback: '🥈' }, // Silver 3
  12: { id: '5265189979985849745', fallback: '🥇' }, // Gold 1
  13: { id: '5264912013997417357', fallback: '🥇' }, // Gold 2
  14: { id: '5265033359708430577', fallback: '🥇' }, // Gold 3
  15: { id: '5267223973418014735', fallback: '🐳' }, // Platinum 1
  16: { id: '5264840455547297024', fallback: '🐳' }, // Platinum 2
  17: { id: '5267360927040181247', fallback: '🐳' }, // Platinum 3
  18: { id: '5267083712671028280', fallback: '💎' }, // Diamond 1
  19: { id: '5265099068413087642', fallback: '💎' }, // Diamond 2
  20: { id: '5267233688634038174', fallback: '💎' }, // Diamond 3
  21: { id: '5267139560130781844', fallback: '🟩' }, // Ascendant 1
  22: { id: '5267384557950246335', fallback: '🟩' }, // Ascendant 2
  23: { id: '5264896161273127395', fallback: '🟩' }, // Ascendant 3
  24: { id: '5264803819476262754', fallback: '♦️' }, // Immortal 1
  25: { id: '5266963281788053597', fallback: '♦️' }, // Immortal 2
  26: { id: '5265120994221140775', fallback: '♦️' }, // Immortal 3
  27: { id: '5267169736571001201', fallback: '🌟' }, // Radiant
};

export const RANK_LABEL_TO_ID: Record<string, number> = {
  'Unranked':    0,
  'Iron 1':      3,
  'Iron 2':      4,
  'Iron 3':      5,
  'Bronze 1':    6,
  'Bronze 2':    7,
  'Bronze 3':    8,
  'Silver 1':    9,
  'Silver 2':   10,
  'Silver 3':   11,
  'Gold 1':     12,
  'Gold 2':     13,
  'Gold 3':     14,
  'Platinum 1': 15,
  'Platinum 2': 16,
  'Platinum 3': 17,
  'Diamond 1':  18,
  'Diamond 2':  19,
  'Diamond 3':  20,
  'Ascendant 1':21,
  'Ascendant 2':22,
  'Ascendant 3':23,
  'Immortal 1': 24,
  'Immortal 2': 25,
  'Immortal 3': 26,
  'Radiant':    27,
};

/**
 * Render a Telegram custom-emoji HTML tag for the given rank label
 * (e.g. "Diamond 3"). Returns "" for null/undefined/unrecognised input.
 */
export function rankToEmojiHtml(rank: string | null | undefined): string {
  if (!rank) return '';
  const id = RANK_LABEL_TO_ID[rank];
  if (id === undefined) return '';
  const entry = RANK_EMOJI[id];
  if (!entry) return '';
  return `<tg-emoji emoji-id="${entry.id}">${entry.fallback}</tg-emoji>`;
}
