import { renderPlayerName } from '../publisher/player-render.ts';
import { agentToEmojiHtml, mapToEmojiHtml } from '../publisher/valorant-emoji.ts';
import { esc } from '../publisher/templates.ts';

/** One detected event, carrying its match-specific presentation and occurrence count. */
export interface DailyEvent {
  id: number;
  eventType: 'ace' | 'knife_kill';
  puuid: string;
  name: string;
  tag: string;
  rank: string | null;
  agent: string | null;
  map: string | null;
  matchId: string;
  count: number;
}

/** Both icons form one tappable match link in classic sendMessage HTML. */
function matchIcons(event: DailyEvent): string {
  const agent = agentToEmojiHtml(event.agent ?? undefined) || '🦸';
  const map = mapToEmojiHtml(event.map ?? undefined) || '⛰️';
  return `<a href="https://tracker.gg/valorant/match/${esc(event.matchId)}">${agent}/${map}</a>`;
}

function renderEvent(event: DailyEvent): string {
  const player = renderPlayerName({ name: event.name, tag: event.tag, rank: event.rank, isCommunity: true });
  return `- ${player} ${matchIcons(event)}`;
}

/** Input is in detection order; stable sorting preserves first detection for ties. */
export function renderDailyDigest(events: DailyEvent[]): string {
  const sections = ['🍿 Эйсы и ножи за предыдущие 24 часа'];
  for (const [type, heading] of [['ace', '🎯 Эйсы'], ['knife_kill', '🔪 Ножи']] as const) {
    const players = new Map<string, { count: number; events: DailyEvent[] }>();
    for (const event of events) {
      if (event.eventType !== type) continue;
      const group = players.get(event.puuid) ?? { count: 0, events: [] };
      group.count += event.count;
      group.events.push(event);
      players.set(event.puuid, group);
    }
    const rows = [...players.values()].sort((a, b) => b.count - a.count).flatMap((group) =>
      group.events.flatMap((event) => Array.from({ length: event.count }, () => renderEvent(event))),
    );
    if (rows.length) sections.push([heading, ...rows].join('\n'));
  }
  return sections.join('\n\n');
}
