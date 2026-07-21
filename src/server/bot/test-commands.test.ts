import { describe, it, expect, vi } from 'vitest';
import {
  isOwner,
  OWNER_TELEGRAM_ID,
  parseDaysArg,
  makeTestDigestHandler,
  makeTestRuntimeEventsHandler,
  collapseGroupableEvents,
  buildRichDigestPayload,
} from './test-commands.ts';

describe('isOwner', () => {
  it('returns true for the hardcoded OWNER_TELEGRAM_ID', () => {
    expect(isOwner(OWNER_TELEGRAM_ID)).toBe(true);
  });

  it('returns false for any other telegram_id', () => {
    expect(isOwner(99999)).toBe(false);
    expect(isOwner(OWNER_TELEGRAM_ID + 1)).toBe(false);
  });

  it('returns false when telegram_id is undefined', () => {
    expect(isOwner(undefined)).toBe(false);
  });
});

describe('parseDaysArg', () => {
  it('returns fallback when text is undefined', () => {
    expect(parseDaysArg(undefined, 7)).toBe(7);
  });

  it('returns fallback when text has no argument', () => {
    expect(parseDaysArg('/test_digest', 7)).toBe(7);
    expect(parseDaysArg('/test_digest   ', 7)).toBe(7);
  });

  it('parses a positive integer argument', () => {
    expect(parseDaysArg('/test_digest 3', 7)).toBe(3);
    expect(parseDaysArg('/test_digest 14', 7)).toBe(14);
  });

  it('strips @botname suffix', () => {
    expect(parseDaysArg('/test_digest@MyBot 5', 7)).toBe(5);
  });

  it('clamps below MIN_DAYS=1 to MIN_DAYS', () => {
    expect(parseDaysArg('/test_digest 0', 7)).toBe(1);
    expect(parseDaysArg('/test_digest -3', 7)).toBe(1);
  });

  it('clamps above MAX_DAYS=30 to MAX_DAYS', () => {
    expect(parseDaysArg('/test_digest 100', 7)).toBe(30);
  });

  it('returns fallback for non-integer values', () => {
    expect(parseDaysArg('/test_digest 7.5', 7)).toBe(7);
    expect(parseDaysArg('/test_digest abc', 7)).toBe(7);
  });

  it('takes only the first positional token', () => {
    expect(parseDaysArg('/test_digest 5 extra ignored', 7)).toBe(5);
  });
});

describe('admin gate (non-owner is silently ignored)', () => {
  function makeMockBot() {
    return {
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    };
  }
  function makeMockDb() {
    return {
      select: vi.fn(),
    };
  }

  it('test_digest handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_digest 3' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_runtime_events handler: non-owner triggers no DB query and no send', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestRuntimeEventsHandler({ db, bot: bot as never });
    const ctx = { from: { id: 99999 }, message: { text: '/test_runtime_events 2' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(db.select).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('test_digest handler: missing ctx.from is treated as non-owner', async () => {
    const bot = makeMockBot();
    const db = makeMockDb();
    const handler = makeTestDigestHandler({ db, bot: bot as never });
    const ctx = { message: { text: '/test_digest' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handler(ctx as any, async () => {});
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('buildRichDigestPayload', () => {
  const DIGEST = '<b>Дайджест</b>\nстрока 2 <tg-emoji emoji-id="123">🐳</tg-emoji>';

  it('returns exactly one of html/markdown/blocks (only html)', () => {
    const payload = buildRichDigestPayload(DIGEST) as unknown as Record<string, unknown>;
    const keysUsed = ['html', 'markdown', 'blocks'].filter((k) => k in payload);
    expect(keysUsed).toEqual(['html']);
    expect(typeof payload['html']).toBe('string');
  });

  it('preserves the digest HTML byte-for-byte as a prefix', () => {
    const { html } = buildRichDigestPayload(DIGEST);
    expect(html.startsWith(DIGEST)).toBe(true);
  });

  it('appends a section heading, a table, and a collapsible Details section', () => {
    const { html } = buildRichDigestPayload(DIGEST);
    // section heading
    expect(html).toContain('<h3>Тест rich-блоков</h3>');
    // table with 3 header columns
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Карта</th>');
    expect(html).toContain('<th>Матчи</th>');
    expect(html).toContain('<th>Эмодзи</th>');
    expect(html).toContain('</table>');
    // collapsible details with summary + multi-line body
    expect(html).toContain('<details><summary>Подробности (свернуто)</summary>');
    expect(html).toContain('</details>');
  });

  it('embeds a real custom emoji (tg-emoji) inside a table cell', () => {
    const { html } = buildRichDigestPayload(DIGEST);
    // Ascent map emoji id from the group's pack (valorant-emoji.ts).
    expect(html).toContain('<td><tg-emoji emoji-id="5267510877233387981">🗺️</tg-emoji></td>');
  });

  it('only appends — does not mutate the digest HTML', () => {
    const { html } = buildRichDigestPayload(DIGEST);
    const appended = html.slice(DIGEST.length);
    // everything after the preserved prefix is the test block, nothing before it
    expect(appended).toContain('<h3>Тест rich-блоков</h3>');
    expect(html.indexOf(DIGEST)).toBe(0);
  });
});

describe('collapseGroupableEvents', () => {
  const baseEv = { payload_json: '{}', detected_at: 0 } as const;

  it('keeps the earliest match_comeback row per match and drops siblings', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'b', match_id: 'm1', detected_at: 110 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'c', match_id: 'm1', detected_at: 120 },
    ];
    const out = collapseGroupableEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]!.riot_puuid).toBe('a');
  });

  it('does not collapse match_comeback across different matches', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: 'm2', detected_at: 110 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(2);
  });

  it('does not collapse non-groupable event types', () => {
    const events = [
      { ...baseEv, event_type: 'ace', riot_puuid: 'a', match_id: 'm1', detected_at: 100 },
      { ...baseEv, event_type: 'ace', riot_puuid: 'b', match_id: 'm1', detected_at: 110 },
      { ...baseEv, event_type: 'teamkill', riot_puuid: 'a', match_id: 'm1', detected_at: 120 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(3);
  });

  it('passes through groupable rows with null match_id (defensive)', () => {
    const events = [
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'a', match_id: null, detected_at: 100 },
      { ...baseEv, event_type: 'match_comeback', riot_puuid: 'b', match_id: null, detected_at: 110 },
    ];
    expect(collapseGroupableEvents(events)).toHaveLength(2);
  });
});
