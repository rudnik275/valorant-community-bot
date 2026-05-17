import { describe, it, expect } from 'vitest';
import {
  encodeKillEvents,
  encodeRounds,
  decodeKillEvents,
  decodeRounds,
  type KillEventCompact,
  type RoundCompact,
} from './match-codec.ts';

describe('match-codec', () => {
  describe('kill events round-trip', () => {
    it('round-trips a v3-shaped kill event (no victim_name/tag)', () => {
      const events: KillEventCompact[] = [
        {
          round: 0,
          attacker_team: 'Blue',
          victim_team: 'Red',
          weapon: 'Vandal',
          attacker_puuid: 'a',
          victim_puuid: 'b',
        },
      ];
      expect(decodeKillEvents(encodeKillEvents(events))).toEqual(events);
    });

    it('round-trips a v4-shaped kill event (with victim_name/tag)', () => {
      const events: KillEventCompact[] = [
        {
          round: 3,
          attacker_team: 'Red',
          victim_team: 'Blue',
          weapon: 'Knife',
          attacker_puuid: 'x',
          victim_puuid: 'y',
          victim_name: 'Victim',
          victim_tag: 'EUW',
        },
      ];
      const decoded = decodeKillEvents(encodeKillEvents(events));
      expect(decoded).toEqual(events);
      expect(decoded[0]!.victim_name).toBe('Victim');
      expect(decoded[0]!.victim_tag).toBe('EUW');
    });

    it('preserves the exact wire string (JSON.stringify, format unchanged)', () => {
      const events: KillEventCompact[] = [
        {
          round: 1,
          attacker_team: 'Blue',
          victim_team: 'Red',
          weapon: 'Phantom',
          attacker_puuid: 'a',
          victim_puuid: 'b',
        },
      ];
      expect(encodeKillEvents(events)).toBe(JSON.stringify(events));
    });

    it('round-trips an empty array', () => {
      expect(decodeKillEvents(encodeKillEvents([]))).toEqual([]);
    });
  });

  describe('rounds round-trip', () => {
    it('round-trips rounds with and without ceremony', () => {
      const rounds: RoundCompact[] = [
        { r: 0, w: 'Blue', c: 'CeremonyAce' },
        { r: 1, w: 'Red' },
      ];
      expect(decodeRounds(encodeRounds(rounds))).toEqual(rounds);
    });

    it('preserves the exact wire string (JSON.stringify, format unchanged)', () => {
      const rounds: RoundCompact[] = [{ r: 2, w: 'Blue' }];
      expect(encodeRounds(rounds)).toBe(JSON.stringify(rounds));
    });
  });

  describe('decode degradation contract (single source)', () => {
    it('decodeKillEvents → [] on null', () => {
      expect(decodeKillEvents(null)).toEqual([]);
    });

    it('decodeKillEvents → [] on undefined', () => {
      expect(decodeKillEvents(undefined)).toEqual([]);
    });

    it('decodeKillEvents → [] on empty string', () => {
      expect(decodeKillEvents('')).toEqual([]);
    });

    it('decodeKillEvents → [] on malformed JSON', () => {
      expect(decodeKillEvents('not-valid-json')).toEqual([]);
    });

    it('decodeKillEvents → [] on valid JSON that is not an array', () => {
      expect(decodeKillEvents('{"round":0}')).toEqual([]);
      expect(decodeKillEvents('null')).toEqual([]);
      expect(decodeKillEvents('42')).toEqual([]);
    });

    it('decodeRounds → [] on null/undefined/empty/malformed/non-array', () => {
      expect(decodeRounds(null)).toEqual([]);
      expect(decodeRounds(undefined)).toEqual([]);
      expect(decodeRounds('')).toEqual([]);
      expect(decodeRounds('{bad')).toEqual([]);
      expect(decodeRounds('"a string"')).toEqual([]);
    });

    it('decodes a real persisted-shape blob (legacy v3, no name/tag)', () => {
      const blob = JSON.stringify([
        { round: 0, attacker_team: 'Blue', victim_team: 'Red', weapon: 'Sheriff', attacker_puuid: 'p1', victim_puuid: 'p2' },
      ]);
      const decoded = decodeKillEvents(blob);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.victim_name).toBeUndefined();
      expect(decoded[0]!.victim_tag).toBeUndefined();
    });
  });
});
