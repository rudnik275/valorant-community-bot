import { describe, it, expect } from 'vitest';
import { deriveMatchRecord, deriveMatchRoster } from './derive.ts';
import type { HenrikMatchV4 } from '../lib/henrik.ts';

import v4Fixture from './__fixtures__/match_console_v4.json';
import v4UnrankedFixture from './__fixtures__/match_console_v4_unranked.json';

const TARGET_PUUID = 'target-puuid';

describe('deriveMatchRecord (v4)', () => {
  describe('v4 competitive fixture (match_console_v4.json)', () => {
    it('maps match_id from metadata.match_id', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record).not.toBeNull();
      expect(record!.match_id).toBe('console-match-v4-001');
    });

    it('maps started_at from Date.parse(metadata.started_at)', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.started_at).toBe(Date.parse('2026-05-09T14:00:00.000Z'));
    });

    it('maps map from metadata.map.name', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.map).toBe('Ascent');
    });

    it('maps agent from players[].agent.name for matching puuid', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.agent).toBe('Jett');
    });

    it('maps kills/deaths/assists from players[].stats', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.kills).toBe(22);
      expect(record!.deaths).toBe(14);
      expect(record!.assists).toBe(4);
    });

    it('returns result=win when players team.won=true', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.result).toBe('win');
    });

    it('computes rounds_played from teams[0].rounds.won + rounds.lost', () => {
      // Blue: won=14, lost=11 → 25 rounds total
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.rounds_played).toBe(25);
    });

    it('sets rank_before to null', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.rank_before).toBeNull();
    });

    it('sets rank_after from players[].tier.name', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.rank_after).toBe('Diamond 1');
    });

    it('sets riot_puuid correctly', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.riot_puuid).toBe(TARGET_PUUID);
    });

    it('has zero fall_damage_kills when no fall damage events', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.fall_damage_kills).toBe(0);
    });

    it('generates kill_events_compact as a valid JSON array', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as unknown[];
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(3); // 3 kills in fixture
    });

    it('kill_events_compact entries have expected shape for detectors', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as Array<{
        round: number;
        attacker_team: string;
        victim_team: string;
        weapon: string;
        attacker_puuid: string;
        victim_puuid: string;
      }>;
      const first = events[0]!;
      expect(typeof first.round).toBe('number');
      expect(typeof first.attacker_team).toBe('string');
      expect(typeof first.victim_team).toBe('string');
      expect(typeof first.weapon).toBe('string');
      expect(typeof first.attacker_puuid).toBe('string');
      expect(typeof first.victim_puuid).toBe('string');
    });

    it('maps score from players[].stats.score', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.score).toBe(5800);
    });

    it('maps headshots/bodyshots/legshots from players[].stats', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.headshots).toBe(35);
      expect(record!.bodyshots).toBe(60);
      expect(record!.legshots).toBe(5);
    });

    it('maps damage_dealt/damage_received from players[].stats.damage', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.damage_dealt).toBe(4200);
      expect(record!.damage_received).toBe(3100);
    });

    it('maps team_rounds_won/lost from player team rounds', () => {
      // Blue (target team): won=14, lost=11
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.team_rounds_won).toBe(14);
      expect(record!.team_rounds_lost).toBe(11);
    });

    it('maps game_length_ms from metadata.game_length_in_ms', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.game_length_ms).toBe(2211603);
    });

    it('flags is_match_mvp=1 when target has the highest score in the match', () => {
      // Fixture: target score=5800, highest among all 10 players
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.is_match_mvp).toBe(1);
    });

    it('flags is_match_mvp=0 when another player has higher score', () => {
      const losingMvpMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: (v4Fixture as HenrikMatchV4).players.map((p) =>
          p.puuid === 'enemy-1'
            ? { ...p, stats: { ...p.stats!, score: 9999 } }
            : p,
        ),
      } as HenrikMatchV4;

      const record = deriveMatchRecord(losingMvpMatch, TARGET_PUUID);
      expect(record!.is_match_mvp).toBe(0);
    });

    it('flags is_match_mvp=1 for all players tied for max score', () => {
      const tieMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: (v4Fixture as HenrikMatchV4).players.map((p) =>
          p.puuid === 'enemy-1'
            ? { ...p, stats: { ...p.stats!, score: 5800 } } // ties target's 5800
            : p,
        ),
      } as HenrikMatchV4;

      const targetRecord = deriveMatchRecord(tieMatch, TARGET_PUUID);
      const enemyRecord = deriveMatchRecord(tieMatch, 'enemy-1');
      expect(targetRecord!.is_match_mvp).toBe(1);
      expect(enemyRecord!.is_match_mvp).toBe(1);
    });

    it('returns is_match_mvp=null when target has no score', () => {
      const noScoreMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: [
          {
            ...(v4Fixture as HenrikMatchV4).players[0]!,
            stats: { kills: 5, deaths: 5, assists: 5 },
          },
          ...(v4Fixture as HenrikMatchV4).players.slice(1),
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(noScoreMatch, TARGET_PUUID);
      expect(record!.is_match_mvp).toBeNull();
    });

    it('returns null for stats fields when Henrik omits them', () => {
      const noStatsMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: [
          {
            ...(v4Fixture as HenrikMatchV4).players[0]!,
            stats: { kills: 5, deaths: 5, assists: 5 },
          },
          ...(v4Fixture as HenrikMatchV4).players.slice(1),
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(noStatsMatch, TARGET_PUUID);
      expect(record!.score).toBeNull();
      expect(record!.headshots).toBeNull();
      expect(record!.damage_dealt).toBeNull();
      expect(record!.damage_received).toBeNull();
    });

    it('kill_events_compact first entry maps correctly from v4 killer/victim/weapon', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      const events = JSON.parse(record!.kill_events_compact) as Array<{
        round: number;
        attacker_team: string;
        victim_team: string;
        weapon: string;
        attacker_puuid: string;
        victim_puuid: string;
      }>;
      const first = events[0]!;
      // From fixture kill[0]: round=1, killer.team=Blue, victim.team=Red, weapon.name=Vandal
      expect(first.round).toBe(1);
      expect(first.attacker_team).toBe('Blue');
      expect(first.victim_team).toBe('Red');
      expect(first.weapon).toBe('Vandal');
      expect(first.attacker_puuid).toBe(TARGET_PUUID);
      expect(first.victim_puuid).toBe('enemy-1');
    });
  });

  // ── enemy_avg_rank ──────────────────────────────────────────────────────────

  describe('enemy_avg_rank computation', () => {
    it('averages opposing team tiers (rounded) and returns tier name', () => {
      // v4Fixture: target is Blue (tier 18), enemies are Red: 18, 19, 20, 17, 18
      // avg = (18+19+20+17+18)/5 = 92/5 = 18.4 → rounds to 18 → Diamond 1
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBe('Diamond 1');
    });

    it('returns null when all opponents have tier.id < 3 (unranked)', () => {
      const unrankedMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: [
          ...(v4Fixture as HenrikMatchV4).players.filter((p) => p.puuid === TARGET_PUUID),
          {
            puuid: 'unranked-enemy',
            name: 'UnrankedEnemy',
            tag: 'UE1',
            team_id: 'Red',
            platform: 'playstation',
            agent: { id: 'xxx', name: 'Sage' },
            tier: { id: 0, name: 'Unrated' },
            stats: { kills: 5, deaths: 10, assists: 2 },
          },
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(unrankedMatch, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBeNull();
    });

    it('returns null when there are no opponents', () => {
      const soloMatch: HenrikMatchV4 = {
        ...v4Fixture,
        players: (v4Fixture as HenrikMatchV4).players.filter((p) => p.puuid === TARGET_PUUID),
      } as HenrikMatchV4;

      const record = deriveMatchRecord(soloMatch, TARGET_PUUID);
      expect(record!.enemy_avg_rank).toBeNull();
    });
  });

  // ── Result variants ─────────────────────────────────────────────────────────

  describe('result derivation', () => {
    it('returns loss when opponent team.won=true', () => {
      const lossMatch: HenrikMatchV4 = {
        ...v4Fixture,
        teams: [
          { team_id: 'Blue', won: false, rounds: { won: 11, lost: 14 } },
          { team_id: 'Red', won: true, rounds: { won: 14, lost: 11 } },
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(lossMatch, TARGET_PUUID);
      expect(record!.result).toBe('loss');
    });

    it('returns draw when neither team won and rounds are equal', () => {
      const drawMatch: HenrikMatchV4 = {
        ...v4Fixture,
        teams: [
          { team_id: 'Blue', won: false, rounds: { won: 12, lost: 12 } },
          { team_id: 'Red', won: false, rounds: { won: 12, lost: 12 } },
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(drawMatch, TARGET_PUUID);
      expect(record!.result).toBe('draw');
    });
  });

  // ── Fall damage ─────────────────────────────────────────────────────────────

  describe('fall_damage_kills', () => {
    it('counts fall damage deaths where victim.puuid matches target and weapon.id=Fall', () => {
      const fallMatch: HenrikMatchV4 = {
        ...v4Fixture,
        kills: [
          {
            round: 2,
            time_in_round_in_ms: 5000,
            killer: { puuid: '', name: '', tag: '', team: 'Red' },
            victim: { puuid: TARGET_PUUID, name: 'Player', tag: 'EU1', team: 'Blue' },
            weapon: { id: 'Fall', name: 'Fall', type: 'EnvironmentalDamage' },
          },
          {
            round: 5,
            time_in_round_in_ms: 3000,
            killer: { puuid: 'enemy-1', name: 'Enemy1', tag: 'NA1', team: 'Red' },
            victim: { puuid: TARGET_PUUID, name: 'Player', tag: 'EU1', team: 'Blue' },
            weapon: { id: 'Vandal', name: 'Vandal', type: 'Rifle' },
          },
          {
            round: 7,
            time_in_round_in_ms: 8000,
            killer: { puuid: '', name: '', tag: '', team: 'Red' },
            victim: { puuid: TARGET_PUUID, name: 'Player', tag: 'EU1', team: 'Blue' },
            weapon: { id: 'Fall', name: 'Fall', type: 'EnvironmentalDamage' },
          },
        ],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(fallMatch, TARGET_PUUID);
      expect(record!.fall_damage_kills).toBe(2);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns null when target puuid is not in players list', () => {
      const record = deriveMatchRecord(v4Fixture as HenrikMatchV4, 'non-existent-puuid');
      expect(record).toBeNull();
    });

    it('handles missing started_at gracefully (returns 0)', () => {
      const noDateMatch: HenrikMatchV4 = {
        ...v4Fixture,
        metadata: {
          ...v4Fixture.metadata,
          started_at: undefined as unknown as string,
        },
      } as HenrikMatchV4;

      const record = deriveMatchRecord(noDateMatch, TARGET_PUUID);
      expect(record!.started_at).toBe(0);
    });

    it('handles missing teams gracefully (result defaults sensibly)', () => {
      const noTeamsMatch: HenrikMatchV4 = {
        ...v4Fixture,
        teams: [],
      } as HenrikMatchV4;

      const record = deriveMatchRecord(noTeamsMatch, TARGET_PUUID);
      // No teams found → no playerTeam or opponentTeam → falls into else branch
      expect(record).not.toBeNull();
      // rounds_played with no teams → 0
      expect(record!.rounds_played).toBe(0);
    });
  });

  // ── Non-competitive fixture (should still derive — queue filtering is in scan.ts) ──

  describe('unranked/deathmatch fixture (match_console_v4_unranked.json)', () => {
    it('still derives a record (queue filtering is callers responsibility)', () => {
      // Derive should work on any v4 match; scan.ts does the queue.id filter
      const record = deriveMatchRecord(v4UnrankedFixture as HenrikMatchV4, TARGET_PUUID);
      // The fixture has target-puuid so it should return a record (not null)
      expect(record).not.toBeNull();
    });
  });
});

describe('deriveMatchRoster', () => {
  it('returns all 10 players from the fixture', () => {
    const rosters = deriveMatchRoster(v4Fixture as HenrikMatchV4);
    expect(rosters).toHaveLength(10);
  });

  it('splits players by team correctly (5 Blue, 5 Red)', () => {
    const rosters = deriveMatchRoster(v4Fixture as HenrikMatchV4);
    const blue = rosters.filter((r) => r.team === 'Blue');
    const red = rosters.filter((r) => r.team === 'Red');
    expect(blue).toHaveLength(5);
    expect(red).toHaveLength(5);
  });

  it('includes name and tag fields for each player', () => {
    const rosters = deriveMatchRoster(v4Fixture as HenrikMatchV4);
    const target = rosters.find((r) => r.riot_puuid === 'target-puuid');
    expect(target).toBeDefined();
    expect(target!.name).toBe('Player');
    expect(target!.tag).toBe('EU1');
  });

  it('uses match_id from metadata', () => {
    const rosters = deriveMatchRoster(v4Fixture as HenrikMatchV4);
    rosters.forEach((r) => expect(r.match_id).toBe(v4Fixture.metadata.match_id));
  });

  it('returns empty array when metadata.match_id is missing', () => {
    const bad = { ...v4Fixture, metadata: {} };
    expect(deriveMatchRoster(bad as unknown as HenrikMatchV4)).toEqual([]);
  });
});
