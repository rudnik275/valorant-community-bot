import { describe, it, expect } from 'vitest';
import { deriveMatchRecord } from './derive.ts';
import type { HenrikMatch } from '../lib/henrik.ts';

import winFixture from './__fixtures__/henrik-match-win.json';
import lossFixture from './__fixtures__/henrik-match-loss.json';
import drawFixture from './__fixtures__/henrik-match-draw.json';
import nonCompetitiveFixture from './__fixtures__/henrik-match-non-competitive.json';
import fallAceFixture from './__fixtures__/henrik-match-fall-ace.json';

const TARGET_PUUID = 'target-puuid';

describe('deriveMatchRecord', () => {
  describe('win fixture', () => {
    it('returns result=win when player team has_won=true', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record).not.toBeNull();
      expect(record!.result).toBe('win');
    });

    it('maps match metadata correctly', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.match_id).toBe('match-win-001');
      expect(record!.map).toBe('Ascent');
      expect(record!.agent).toBe('Jett');
      expect(record!.started_at).toBe(1700000000 * 1000);
      expect(record!.rounds_played).toBe(25);
    });

    it('maps player stats correctly', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.kills).toBe(22);
      expect(record!.deaths).toBe(14);
      expect(record!.assists).toBe(4);
      expect(record!.rank_after).toBe('Diamond 1');
      expect(record!.rank_before).toBeNull();
    });

    it('calculates enemy_avg_rank for enemy Red team', () => {
      // Enemy team (Red): tiers 18, 19, 20, 17, 18 → avg = 92/5 = 18.4 → rounds to 18 → Diamond 1
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBe('Diamond 1');
    });

    it('has zero fall_damage_kills when no fall damage events', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.fall_damage_kills).toBe(0);
    });

    it('generates kill_events_compact as valid JSON array', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as unknown[];
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(3);
    });

    it('sets riot_puuid correctly', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.riot_puuid).toBe(TARGET_PUUID);
    });
  });

  describe('loss fixture', () => {
    it('returns result=loss when enemy team has_won=true', () => {
      const record = deriveMatchRecord(lossFixture as HenrikMatch, TARGET_PUUID);
      expect(record).not.toBeNull();
      expect(record!.result).toBe('loss');
    });

    it('maps map correctly', () => {
      const record = deriveMatchRecord(lossFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.map).toBe('Haven');
    });

    it('calculates enemy_avg_rank for enemy Blue team', () => {
      // Enemy Blue tiers: 24, 21, 22, 21, 22 → avg = 110/5 = 22 → Ascendant 2
      const record = deriveMatchRecord(lossFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBe('Ascendant 2');
    });
  });

  describe('draw fixture', () => {
    it('returns result=draw when both teams have has_won=false and equal rounds', () => {
      const record = deriveMatchRecord(drawFixture as HenrikMatch, TARGET_PUUID);
      expect(record).not.toBeNull();
      expect(record!.result).toBe('draw');
    });

    it('maps map correctly', () => {
      const record = deriveMatchRecord(drawFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.map).toBe('Bind');
    });
  });

  describe('non-competitive fixture', () => {
    it('returns null for non-competitive match', () => {
      const record = deriveMatchRecord(nonCompetitiveFixture as HenrikMatch, TARGET_PUUID);
      expect(record).toBeNull();
    });
  });

  describe('fall damage + ace fixture', () => {
    it('counts fall_damage_kills correctly (2 fall deaths of target puuid)', () => {
      const record = deriveMatchRecord(fallAceFixture as HenrikMatch, TARGET_PUUID);
      expect(record).not.toBeNull();
      // 2 kills where victim_puuid=target-puuid and damage_type='Fall'
      expect(record!.fall_damage_kills).toBe(2);
    });

    it('includes all kill events in kill_events_compact', () => {
      const record = deriveMatchRecord(fallAceFixture as HenrikMatch, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as unknown[];
      expect(events).toHaveLength(8); // all 8 kill events in fixture
    });

    it('kill_events_compact entries have expected shape', () => {
      const record = deriveMatchRecord(fallAceFixture as HenrikMatch, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as Array<{
        round: number;
        attacker_team: string;
        victim_team: string;
        weapon: string;
        attacker_puuid: string;
        victim_puuid: string;
      }>;
      const first = events[0]!;
      expect(first).toHaveProperty('round');
      expect(first).toHaveProperty('attacker_team');
      expect(first).toHaveProperty('victim_team');
      expect(first).toHaveProperty('weapon');
      expect(first).toHaveProperty('attacker_puuid');
      expect(first).toHaveProperty('victim_puuid');
    });

    it('returns win result', () => {
      const record = deriveMatchRecord(fallAceFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.result).toBe('win');
    });

    it('calculates enemy_avg_rank for enemy Red team', () => {
      // Enemy Red tiers: 18, 19, 18, 17, 18 → avg = 90/5 = 18 → Diamond 1
      const record = deriveMatchRecord(fallAceFixture as HenrikMatch, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBe('Diamond 1');
    });
  });

  describe('edge cases', () => {
    it('returns null when target puuid is not in player list', () => {
      const record = deriveMatchRecord(winFixture as HenrikMatch, 'non-existent-puuid');
      expect(record).toBeNull();
    });

    it('falls back to rounds_played from rounds array length when metadata missing it', () => {
      const match: HenrikMatch = {
        ...winFixture,
        metadata: {
          ...winFixture.metadata,
          rounds_played: undefined as unknown as number,
        },
        rounds: [{}, {}, {}, {}] as unknown[],
      } as HenrikMatch;
      const record = deriveMatchRecord(match, TARGET_PUUID);
      expect(record!.rounds_played).toBe(4);
    });
  });
});
