import type { Detector } from '../types.ts';
import { aceDetector } from './ace.ts';
import { aceRareWeaponDetector } from './ace-rare-weapon.ts';
import { rankPromoDetector } from './rank-promo.ts';
import { winstreakDetector } from './winstreak.ts';
import { giantSlayerDetector } from './giant-slayer.ts';
import { returnAfterPauseDetector } from './return-after-pause.ts';
import { teamkillDetector } from './teamkill.ts';
import { fallDamageDeathDetector } from './fall-damage-death.ts';

export const ALL_DETECTORS: Detector[] = [
  aceDetector,
  aceRareWeaponDetector,
  rankPromoDetector,
  winstreakDetector,
  giantSlayerDetector,
  returnAfterPauseDetector,
  teamkillDetector,
  fallDamageDeathDetector,
];
