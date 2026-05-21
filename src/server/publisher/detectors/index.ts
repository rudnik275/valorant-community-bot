import type { Detector } from '../types.ts';
import { aceDetector } from './ace.ts';
import { winstreakDetector } from './winstreak.ts';
import { giantSlayerDetector } from './giant-slayer.ts';
import { returnAfterPauseDetector } from './return-after-pause.ts';
import { teamkillDetector } from './teamkill.ts';
import { fallDamageDeathDetector } from './fall-damage-death.ts';
import { recordKillsMatchDetector } from './record-kills-match.ts';
import { recordDamageDealtMatchDetector } from './record-damage-dealt-match.ts';
import { recordDamageReceivedMatchDetector } from './record-damage-received-match.ts';
import { recordDeathsMatchDetector } from './record-deaths-match.ts';
import { recordHeadshotsMatchDetector } from './record-headshots-match.ts';
import { recordLegshotsMatchDetector } from './record-legshots-match.ts';
import { knifeKillDetector } from './knife-kill.ts';
import { matchComebackDetector } from './match-comeback.ts';
import { communityClashDetector } from './community-clash.ts';
import { recordKillsPerWeaponDetector } from './record-kills-per-weapon.ts';
import { recordLongestMatchMinutesDetector } from './record-longest-match-minutes.ts';
import { recordSurvivedLastRoundsDetector } from './record-survived-last-rounds.ts';
import { recordDiedFirstRoundsDetector } from './record-died-first-rounds.ts';

export const ALL_DETECTORS: Detector[] = [
  aceDetector,
  winstreakDetector,
  giantSlayerDetector,
  returnAfterPauseDetector,
  teamkillDetector,
  fallDamageDeathDetector,
  recordKillsMatchDetector,
  recordDamageDealtMatchDetector,
  recordDamageReceivedMatchDetector,
  recordDeathsMatchDetector,
  recordHeadshotsMatchDetector,
  recordLegshotsMatchDetector,
  knifeKillDetector,
  matchComebackDetector,
  communityClashDetector,
  recordKillsPerWeaponDetector,
  recordLongestMatchMinutesDetector,
  recordSurvivedLastRoundsDetector,
  recordDiedFirstRoundsDetector,
];
