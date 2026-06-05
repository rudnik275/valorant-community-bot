/**
 * Custom-emoji IDs for Valorant rank icons, keyed by competitive tier number.
 * Pack: https://t.me/addemoji/valorant_npc_by_valorant_comunity_bot — the group's
 * single designated emoji pack (see scripts/launch/build-emoji-pack.ts for why one).
 * Generated 2026-06-05 from valorant-api.com via scripts/launch/build-emoji-pack.ts.
 */
export const RANK_EMOJI: Record<number, { id: string; fallback: string }> = {
  0:  { id: '5264816798867435802', fallback: '❓' }, // Unranked
  3:  { id: '5264830942194736552', fallback: '🪨' }, // Iron 1
  4:  { id: '5267110070885325636', fallback: '🪨' }, // Iron 2
  5:  { id: '5264836259364249852', fallback: '🪨' }, // Iron 3
  6:  { id: '5265254374430513323', fallback: '🥉' }, // Bronze 1
  7:  { id: '5264944389460893958', fallback: '🥉' }, // Bronze 2
  8:  { id: '5267372278638745688', fallback: '🥉' }, // Bronze 3
  9:  { id: '5267464736399728495', fallback: '🥈' }, // Silver 1
  10: { id: '5265139299371755545', fallback: '🥈' }, // Silver 2
  11: { id: '5267159853851252174', fallback: '🥈' }, // Silver 3
  12: { id: '5267322792025559955', fallback: '🥇' }, // Gold 1
  13: { id: '5267288028560266308', fallback: '🥇' }, // Gold 2
  14: { id: '5267385988174355073', fallback: '🥇' }, // Gold 3
  15: { id: '5264763678711913942', fallback: '🐳' }, // Platinum 1
  16: { id: '5267016462073109449', fallback: '🐳' }, // Platinum 2
  17: { id: '5267162911867968040', fallback: '🐳' }, // Platinum 3
  18: { id: '5265104119294632981', fallback: '💎' }, // Diamond 1
  19: { id: '5267319149893295528', fallback: '💎' }, // Diamond 2
  20: { id: '5265219666799795636', fallback: '💎' }, // Diamond 3
  21: { id: '5267234697951353645', fallback: '🟩' }, // Ascendant 1
  22: { id: '5267357400872030435', fallback: '🟩' }, // Ascendant 2
  23: { id: '5265214873616292974', fallback: '🟩' }, // Ascendant 3
  24: { id: '5264913804998778625', fallback: '♦️' }, // Immortal 1
  25: { id: '5264777216448829032', fallback: '♦️' }, // Immortal 2
  26: { id: '5264934154553828345', fallback: '♦️' }, // Immortal 3
  27: { id: '5267161374269675067', fallback: '🌟' }, // Radiant
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
