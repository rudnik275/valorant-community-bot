/**
 * Custom-emoji IDs for Valorant agents / maps / weapons.
 * Pack: https://t.me/addemoji/valorant_npc_by_valorant_comunity_bot
 * Generated from valorant-api.com assets via scripts/launch/build-emoji-pack.ts.
 * Keys are normalised names: lowercased with all non-alphanumerics stripped
 * (so "KAY/O" -> "kayo", "Ascent" -> "ascent"), matched against Henrik/DB names.
 */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const AGENT_EMOJI: Record<string, string> = {
  gekko: '5267031558883154765', // Gekko
  fade: '5267516280302245743', // Fade
  breach: '5267267988242864087', // Breach
  deadlock: '5267043881144325955', // Deadlock
  tejo: '5264741160198379828', // Tejo
  raze: '5267313940097972586', // Raze
  chamber: '5265061753737221151', // Chamber
  kayo: '5264730598873802961', // KAY/O
  skye: '5265062260543363180', // Skye
  cypher: '5267327825727229308', // Cypher
  sova: '5267031954020145619', // Sova
  miks: '5267023574538949853', // Miks
  killjoy: '5267326966733772335', // Killjoy
  harbor: '5265030305986681107', // Harbor
  vyse: '5267514673984477634', // Vyse
  viper: '5267167271259773403', // Viper
  phoenix: '5267230042206800054', // Phoenix
  veto: '5264910291715529743', // Veto
  astra: '5267408437968409823', // Astra
  brimstone: '5267200179299194226', // Brimstone
  iso: '5264796496557023100', // Iso
  clove: '5265001817468609252', // Clove
  neon: '5265002032216972432', // Neon
  yoru: '5264732690522874258', // Yoru
  waylay: '5264857979013864217', // Waylay
  sage: '5267462919628560472', // Sage
  reyna: '5264748637736442596', // Reyna
  omen: '5264787588794851172', // Omen
  jett: '5265124043647916479', // Jett
};

export const MAP_EMOJI: Record<string, string> = {
  ascent: '5267510877233387981', // Ascent
  split: '5264985457938178838', // Split
  fracture: '5267135892228707975', // Fracture
  bind: '5264782370409583776', // Bind
  breeze: '5267055602110077275', // Breeze
  district: '5267372338768287133', // District
  kasbah: '5267449935942423600', // Kasbah
  drift: '5265021973750125219', // Drift
  glitch: '5264805644837363742', // Glitch
  piazza: '5267206093469161610', // Piazza
  abyss: '5264944329331349814', // Abyss
  lotus: '5267207944600062779', // Lotus
  sunset: '5265048963324614943', // Sunset
  pearl: '5265214555788713935', // Pearl
  icebox: '5267284420787736654', // Icebox
  corrode: '5265090173535821229', // Corrode
  haven: '5267334981142746763', // Haven
};

export const WEAPON_EMOJI: Record<string, string> = {
  odin: '5265155139211142472', // Odin
  ares: '5265058901878941434', // Ares
  vandal: '5267384313137108259', // Vandal
  bulldog: '5264988627624041279', // Bulldog
  phantom: '5267421855446243759', // Phantom
  judge: '5267026353382793117', // Judge
  bucky: '5264770267191749625', // Bucky
  frenzy: '5265010420288100146', // Frenzy
  classic: '5264829533445462492', // Classic
  bandit: '5264834824845171231', // Bandit
  ghost: '5264841490634416725', // Ghost
  sheriff: '5265082472659459467', // Sheriff
  shorty: '5264870348519674455', // Shorty
  operator: '5265001662849784174', // Operator
  guardian: '5264893425378955367', // Guardian
  outlaw: '5264902221471981672', // Outlaw
  marshal: '5264900726823364965', // Marshal
  spectre: '5265136275714773935', // Spectre
  stinger: '5264869395036937067', // Stinger
  melee: '5267101489540668677', // Melee
};

/** Henrik/DB weapon names that differ from the pack's valorant-api name. */
const WEAPON_ALIAS: Record<string, string> = {
  knife: 'melee', // DB stores 'Knife'; pack icon is 'Melee'
};

function tag(id: string, fallback: string): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/** Agent icon, e.g. agentToEmojiHtml("Jett"). "" for unknown/empty. */
export function agentToEmojiHtml(name: string | null | undefined): string {
  if (!name) return '';
  const id = AGENT_EMOJI[norm(name)];
  return id ? tag(id, '🦸') : '';
}

/** Map icon, e.g. mapToEmojiHtml("Ascent"). "" for unknown/empty. */
export function mapToEmojiHtml(name: string | null | undefined): string {
  if (!name) return '';
  const id = MAP_EMOJI[norm(name)];
  return id ? tag(id, '🗺️') : '';
}

/** Weapon icon, e.g. weaponToEmojiHtml("Vandal"). "" for unknown/empty. */
export function weaponToEmojiHtml(name: string | null | undefined): string {
  if (!name) return '';
  const key = norm(name);
  const resolved = WEAPON_ALIAS[key] ?? key;
  const id = WEAPON_EMOJI[resolved];
  if (!id) return '';
  return tag(id, resolved === 'melee' ? '🔪' : '🔫');
}
