import type { Detector } from '../types.ts';
import { aceDetector } from './ace.ts';
import { aceRareWeaponDetector } from './ace-rare-weapon.ts';
import { clutchDetector } from './clutch.ts';
import { rankPromoDetector } from './rank-promo.ts';
import { winstreakDetector } from './winstreak.ts';
import { giantSlayerDetector } from './giant-slayer.ts';
import { comebackDetector } from './comeback.ts';
import { lostrickDetector } from './lostrick.ts';
import { teamkillDetector } from './teamkill.ts';
import { fallDamageDeathDetector } from './fall-damage-death.ts';
import { zeroMatchDetector } from './zero-match.ts';

export const ALL_DETECTORS: Detector[] = [
  aceDetector,
  aceRareWeaponDetector,
  clutchDetector,
  rankPromoDetector,
  winstreakDetector,
  giantSlayerDetector,
  comebackDetector,
  lostrickDetector,
  teamkillDetector,
  fallDamageDeathDetector,
  zeroMatchDetector,
];
