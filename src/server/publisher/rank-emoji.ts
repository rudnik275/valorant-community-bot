/**
 * Custom-emoji IDs for Valorant rank icons, keyed by competitive tier number.
 * Pack: https://t.me/addemoji/valorant_npc_by_valorant_comunity_bot — the group's
 * single designated emoji pack (see scripts/launch/build-emoji-pack.ts for why one).
 * Generated 2026-06-05 from valorant-api.com via scripts/launch/build-emoji-pack.ts.
 */
export const RANK_EMOJI: Record<number, { id: string; fallback: string }> = {
  0:  { id: '5265111296184984182', fallback: '❓' }, // Unranked
  3:  { id: '5267500779765276084', fallback: '🪨' }, // Iron 1
  4:  { id: '5267046213311570879', fallback: '🪨' }, // Iron 2
  5:  { id: '5267095583960635641', fallback: '🪨' }, // Iron 3
  6:  { id: '5267169612016950033', fallback: '🥉' }, // Bronze 1
  7:  { id: '5264830212050297899', fallback: '🥉' }, // Bronze 2
  8:  { id: '5265020324482683107', fallback: '🥉' }, // Bronze 3
  9:  { id: '5267290051489862903', fallback: '🥈' }, // Silver 1
  10: { id: '5267286684235503964', fallback: '🥈' }, // Silver 2
  11: { id: '5264817026500696828', fallback: '🥈' }, // Silver 3
  12: { id: '5267008735426942279', fallback: '🥇' }, // Gold 1
  13: { id: '5265140751070703982', fallback: '🥇' }, // Gold 2
  14: { id: '5267307248538919935', fallback: '🥇' }, // Gold 3
  15: { id: '5265007409516026311', fallback: '🐳' }, // Platinum 1
  16: { id: '5264832819095445772', fallback: '🐳' }, // Platinum 2
  17: { id: '5267092826591633219', fallback: '🐳' }, // Platinum 3
  18: { id: '5265233698457953306', fallback: '💎' }, // Diamond 1
  19: { id: '5264929490219344084', fallback: '💎' }, // Diamond 2
  20: { id: '5264988524544826807', fallback: '💎' }, // Diamond 3
  21: { id: '5265036318940896089', fallback: '🟩' }, // Ascendant 1
  22: { id: '5265246952727030216', fallback: '🟩' }, // Ascendant 2
  23: { id: '5267391030465961034', fallback: '🟩' }, // Ascendant 3
  24: { id: '5265033432722870934', fallback: '♦️' }, // Immortal 1
  25: { id: '5265074011573883882', fallback: '♦️' }, // Immortal 2
  26: { id: '5265119078665724464', fallback: '♦️' }, // Immortal 3
  27: { id: '5267355571215962672', fallback: '🌟' }, // Radiant
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
