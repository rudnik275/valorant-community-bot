import type { Detector } from '../types.ts';
import { aceDetector } from './ace.ts';
import { aceRareWeaponDetector } from './ace-rare-weapon.ts';
import { rankPromoDetector } from './rank-promo.ts';
import { winstreakDetector } from './winstreak.ts';
import { giantSlayerDetector } from './giant-slayer.ts';
import { returnAfterPauseDetector } from './return-after-pause.ts';
import { teamkillDetector } from './teamkill.ts';
import { fallDamageDeathDetector } from './fall-damage-death.ts';
import { recordKillsMatchDetector } from './record-kills-match.ts';
import { knifeKillDetector } from './knife-kill.ts';
import { matchComebackDetector } from './match-comeback.ts';
import { communityClashDetector } from './community-clash.ts';

export const ALL_DETECTORS: Detector[] = [
  aceDetector,
  aceRareWeaponDetector,
  rankPromoDetector,
  winstreakDetector,
  giantSlayerDetector,
  returnAfterPauseDetector,
  teamkillDetector,
  fallDamageDeathDetector,
  recordKillsMatchDetector,
  knifeKillDetector,
  matchComebackDetector,
  communityClashDetector,
];
