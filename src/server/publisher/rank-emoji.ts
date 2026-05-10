/**
 * Custom-emoji IDs for Valorant rank icons.
 * Pack: https://t.me/addemoji/valorant_ranks_by_valorant_comunity_bot
 * Generated 2026-05-10 via scripts/launch/build-emoji-pack.ts.
 */
export const RANK_EMOJI: Record<number, { id: string; fallback: string }> = {
  0:  { id: '5188639300400487669', fallback: '❓' }, // Unranked
  3:  { id: '5188197266661353360', fallback: '🪨' }, // Iron 1
  4:  { id: '5188670911359784625', fallback: '🪨' }, // Iron 2
  5:  { id: '5188609832629867426', fallback: '🪨' }, // Iron 3
  6:  { id: '5188458263233992211', fallback: '🥉' }, // Bronze 1
  7:  { id: '5190867280325552061', fallback: '🥉' }, // Bronze 2
  8:  { id: '5188398296900608799', fallback: '🥉' }, // Bronze 3
  9:  { id: '5188209533087946334', fallback: '🥈' }, // Silver 1
  10: { id: '5188578771426384622', fallback: '🥈' }, // Silver 2
  11: { id: '5188470989222091128', fallback: '🥈' }, // Silver 3
  12: { id: '5190945942651574433', fallback: '🥇' }, // Gold 1
  13: { id: '5188245529208854398', fallback: '🥇' }, // Gold 2
  14: { id: '5188211435758458280', fallback: '🥇' }, // Gold 3
  15: { id: '5188347676416056675', fallback: '🪙' }, // Platinum 1
  16: { id: '5188190789850666271', fallback: '🪙' }, // Platinum 2
  17: { id: '5190917604457357406', fallback: '🪙' }, // Platinum 3
  18: { id: '5190476275092855352', fallback: '💎' }, // Diamond 1
  19: { id: '5190805578825376762', fallback: '💎' }, // Diamond 2
  20: { id: '5190612593059864801', fallback: '💎' }, // Diamond 3
  21: { id: '5188550815484256589', fallback: '💚' }, // Ascendant 1
  22: { id: '5190617957474017123', fallback: '💚' }, // Ascendant 2
  23: { id: '5188300646524165600', fallback: '💚' }, // Ascendant 3
  24: { id: '5188459714932943688', fallback: '🔮' }, // Immortal 1
  25: { id: '5190871815811012515', fallback: '🔮' }, // Immortal 2
  26: { id: '5188596617015497449', fallback: '🔮' }, // Immortal 3
  27: { id: '5190818141604715555', fallback: '🌟' }, // Radiant
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
