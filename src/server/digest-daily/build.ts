/**
 * build.ts — Pure builder for the daily ace digest.
 *
 * Selects ace events from detected_events where:
 *   - event_type = 'ace'
 *   - status IN ('silent', 'digest-only')
 *   - detected_at in [windowStart, windowEnd)
 *   - id NOT IN excludeEventIds
 *
 * Groups by player (riot_puuid), collapses same-match events,
 * and renders a group-by-player Telegram HTML message.
 */

import { and, gte, lt, inArray, notInArray, eq } from 'drizzle-orm';
import { detectedEvents } from '../db/schema/detected_events.ts';
import { users } from '../db/schema/users.ts';
import { matchRecords } from '../db/schema/match_records.ts';
import { esc } from '../publisher/templates.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface BuildDailyDigestDeps {
  db: AnyDb;
  windowStart: number; // ms epoch, inclusive
  windowEnd: number; // ms epoch, exclusive
  excludeEventIds?: number[]; // IDs already posted in prior daily runs
}

export interface BuildDailyDigestResult {
  text: string | null; // null when zero aces
  includedEventIds: number[]; // empty when zero aces
}

interface AceRow {
  id: number;
  puuid: string;
  matchId: string;
  detectedAt: number;
  payloadJson: string;
  riotName: string | null;
  riotTag: string | null;
  map: string | null;
}

interface MatchBullet {
  matchId: string;
  map: string | null;
  maxKills: number;
  aceCount: number; // payload.weapons_per_round.length — number of aces in this match
  detectedAt: number; // earliest detected_at for sorting
}

interface PlayerSection {
  puuid: string;
  riotName: string;
  riotTag: string;
  totalAces: number; // sum of aceCount across all bullets
  earliestDetectedAt: number;
  bullets: MatchBullet[];
}

export async function buildDailyAceDigest(
  deps: BuildDailyDigestDeps,
): Promise<BuildDailyDigestResult> {
  const { db, windowStart, windowEnd, excludeEventIds } = deps;

  // Build the WHERE conditions
  const conditions = [
    eq(detectedEvents.event_type, 'ace'),
    inArray(detectedEvents.status, ['silent', 'digest-only']),
    gte(detectedEvents.detected_at, windowStart),
    lt(detectedEvents.detected_at, windowEnd),
  ];

  if (excludeEventIds && excludeEventIds.length > 0) {
    conditions.push(notInArray(detectedEvents.id, excludeEventIds));
  }

  // Select ace events with user and match info
  const rows = await db
    .select({
      id: detectedEvents.id,
      puuid: detectedEvents.riot_puuid,
      matchId: detectedEvents.match_id,
      detectedAt: detectedEvents.detected_at,
      payloadJson: detectedEvents.payload_json,
      riotName: users.riot_name,
      riotTag: users.riot_tag,
      map: matchRecords.map,
    })
    .from(detectedEvents)
    .leftJoin(users, eq(users.riot_puuid, detectedEvents.riot_puuid))
    .leftJoin(
      matchRecords,
      and(
        eq(matchRecords.match_id, detectedEvents.match_id),
        eq(matchRecords.riot_puuid, detectedEvents.riot_puuid),
      ),
    )
    .where(and(...conditions))
    .orderBy(detectedEvents.detected_at);

  if (rows.length === 0) {
    return { text: null, includedEventIds: [] };
  }

  const typedRows = rows as AceRow[];
  const includedEventIds: number[] = typedRows.map((r) => r.id);

  // Group by puuid
  const playerMap = new Map<string, { rows: AceRow[]; riotName: string; riotTag: string }>();

  for (const row of typedRows) {
    const puuid = row.puuid ?? 'unknown';
    if (!playerMap.has(puuid)) {
      playerMap.set(puuid, {
        rows: [],
        riotName: row.riotName ?? puuid,
        riotTag: row.riotTag ?? '',
      });
    }
    playerMap.get(puuid)!.rows.push(row);
  }

  // Build player sections
  const sections: PlayerSection[] = [];

  for (const [puuid, { rows: playerRows, riotName, riotTag }] of playerMap) {
    // Group this player's rows by matchId
    const matchMap = new Map<string, AceRow[]>();
    for (const row of playerRows) {
      const mid = row.matchId;
      if (!matchMap.has(mid)) matchMap.set(mid, []);
      matchMap.get(mid)!.push(row);
    }

    // Build bullets (one per match). Under the UNIQUE(match_id, event_type,
    // riot_puuid) constraint on detected_events there is at most one row per
    // (match, player); multiple aces in the same match are encoded as multiple
    // entries inside payload.weapons_per_round (length === number of aces).
    const bullets: MatchBullet[] = [];
    for (const [matchId, matchRows] of matchMap) {
      let maxKills = 5;
      let aceCount = 0;
      for (const r of matchRows) {
        try {
          const payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
          const wpr = Array.isArray(payload['weapons_per_round'])
            ? (payload['weapons_per_round'] as unknown[][])
            : [];
          aceCount += wpr.length;
          for (const round of wpr) {
            if (Array.isArray(round) && round.length > maxKills) {
              maxKills = round.length;
            }
          }
        } catch {
          // ignore bad json
        }
      }

      bullets.push({
        matchId,
        map: matchRows[0]?.map ?? null,
        maxKills,
        aceCount: aceCount || matchRows.length,
        detectedAt: Math.min(...matchRows.map((r) => r.detectedAt)),
      });
    }

    // Sort bullets by detectedAt asc
    bullets.sort((a, b) => a.detectedAt - b.detectedAt);

    const totalAces = bullets.reduce((sum, b) => sum + b.aceCount, 0);
    const earliestDetectedAt = Math.min(...playerRows.map((r) => r.detectedAt));

    sections.push({
      puuid,
      riotName,
      riotTag,
      totalAces,
      earliestDetectedAt,
      bullets,
    });
  }

  // Sort sections: by total ace count desc, ties by earliest detected_at asc
  sections.sort((a, b) => {
    if (b.totalAces !== a.totalAces) return b.totalAces - a.totalAces;
    return a.earliestDetectedAt - b.earliestDetectedAt;
  });

  // Render
  const header = `🎯 <b>Ейсы за сутки</b>`;

  const sectionTexts = sections.map((sec) => {
    const playerHeader = `<b>${esc(sec.riotName)}#${esc(sec.riotTag)}</b> (${sec.totalAces})`;

    const bulletLines = sec.bullets.map((b) => {
      const mapPart = b.map ? esc(b.map) : '';
      const killsLabel = b.maxKills > 5 ? `, ${b.maxKills} убийств` : '';
      const multiLabel = b.aceCount >= 2 ? ` ×${b.aceCount}` : '';
      const matchLinkPart = ` · <a href="https://tracker.gg/valorant/match/${esc(b.matchId)}">матч</a>`;
      return `• ${mapPart}${killsLabel}${multiLabel}${matchLinkPart}`;
    });

    return `${playerHeader}\n${bulletLines.join('\n')}`;
  });

  const text = `${header}\n\n${sectionTexts.join('\n\n')}`;

  return { text, includedEventIds };
}
