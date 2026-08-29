/**
 * member-gate.test.ts — the invariant this module exists to hold is
 * «a restriction is never silent». These tests pin that down, plus the
 * ordering rules that keep a half-applied gate from being recorded as done.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import {
  gateMember,
  ungateMember,
  gateNoticeHtml,
  READONLY_PERMISSIONS,
  FULL_PERMISSIONS,
  type MemberGateDeps,
} from './member-gate.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CHAT_A = -1001;
const CHAT_B = -1002;
const USER = 77;

let sqlite: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });
  sqlite.exec(
    `INSERT INTO users (telegram_id, telegram_username, joined_at) VALUES (${USER}, 'nick', ${Date.now()})`,
  );
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

function restrictedAt(): number | null {
  const row = sqlite
    .prepare('SELECT restricted_at FROM users WHERE telegram_id = ?')
    .get(USER) as { restricted_at: number | null };
  return row.restricted_at;
}

function makeDeps(over: Partial<MemberGateDeps> = {}): MemberGateDeps {
  return {
    db,
    restrictChatMember: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    getMiniAppUrl: () => 'https://app.example',
    getNowMs: () => 1_700_000_000_000,
    ...over,
  };
}

describe('gateMember', () => {
  it('restricts every chat but explains exactly once', async () => {
    // One person, one notification — no matter how many chats they are in.
    const deps = makeDeps();
    const res = await gateMember(deps, {
      chatIds: [CHAT_A, CHAT_B],
      userId: USER,
      reason: { kind: 'no_nick' },
      source: 'test',
    });

    expect(deps.restrictChatMember).toHaveBeenCalledTimes(2);
    expect(deps.restrictChatMember).toHaveBeenCalledWith(CHAT_A, USER, READONLY_PERMISSIONS);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(res.restrictedIn).toEqual([CHAT_A, CHAT_B]);
    expect(res.notified).toBe(true);
    expect(restrictedAt()).toBe(1_700_000_000_000);
  });

  it('records nothing and says nothing when every chat refused', async () => {
    // A gate that did not land must stay un-recorded, so the next sweep retries
    // it instead of skipping a member who can still write.
    const deps = makeDeps({
      restrictChatMember: vi.fn().mockRejectedValue(new Error('not an admin')),
    });

    const res = await gateMember(deps, {
      chatIds: [CHAT_A],
      userId: USER,
      reason: { kind: 'no_nick' },
      source: 'test',
    });

    expect(res.restrictedIn).toEqual([]);
    expect(res.notified).toBe(false);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(restrictedAt()).toBeNull();
  });

  it('still records a partial gate', async () => {
    const restrictChatMember = vi.fn()
      .mockRejectedValueOnce(new Error('bot not admin here'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ restrictChatMember });

    const res = await gateMember(deps, {
      chatIds: [CHAT_A, CHAT_B],
      userId: USER,
      reason: { kind: 'no_nick' },
      source: 'test',
    });

    expect(res.restrictedIn).toEqual([CHAT_B]);
    expect(restrictedAt()).not.toBeNull();
    // The notice goes to a chat where the restriction actually applies.
    expect(vi.mocked(deps.notify!).mock.calls[0]![0].chatId).toBe(CHAT_B);
  });

  it('keeps the gate when the notice cannot be delivered', async () => {
    // Being unreachable is common — most members never opened a DM with the
    // bot. A silent gate is bad; an un-gated member is worse.
    const deps = makeDeps({ notify: vi.fn().mockRejectedValue(new Error('blocked')) });

    const res = await gateMember(deps, {
      chatIds: [CHAT_A],
      userId: USER,
      reason: { kind: 'no_nick' },
      source: 'test',
    });

    expect(res.restrictedIn).toEqual([CHAT_A]);
    expect(res.notified).toBe(false);
    expect(restrictedAt()).not.toBeNull();
  });

  it('never throws out of a failing notify', async () => {
    const deps = makeDeps({ notify: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(
      gateMember(deps, { chatIds: [CHAT_A], userId: USER, reason: { kind: 'no_nick' }, source: 'test' }),
    ).resolves.toBeDefined();
  });
});

describe('gateNoticeHtml', () => {
  it('names the nick that failed so the notice is actionable', () => {
    const html = gateNoticeHtml(
      { kind: 'nick_not_found', riotName: 'Kapral', riotTag: '009' },
      'https://app.example',
    );
    expect(html).toContain('Kapral#009');
    expect(html).toContain('https://app.example');
  });

  it('escapes a nick so it cannot inject markup', () => {
    // Riot IDs are user-controlled and end up inside HTML.
    const html = gateNoticeHtml(
      { kind: 'nick_not_found', riotName: '<b>x', riotTag: '&1' },
      '',
    );
    expect(html).toContain('&lt;b&gt;x');
    expect(html).toContain('&amp;1');
  });

  it('still gives an instruction when no Mini App URL is configured', () => {
    const html = gateNoticeHtml({ kind: 'no_nick' }, '');
    expect(html).toContain('Riot ID');
    expect(html).not.toContain('<a href');
  });
});

describe('ungateMember', () => {
  it('clears restricted_at once every chat accepted', async () => {
    sqlite.prepare('UPDATE users SET restricted_at = 123 WHERE telegram_id = ?').run(USER);
    const deps = makeDeps();

    const res = await ungateMember(deps, { chatIds: [CHAT_A, CHAT_B], userId: USER });

    expect(deps.restrictChatMember).toHaveBeenCalledWith(CHAT_A, USER, FULL_PERMISSIONS);
    expect(res.fullyLifted).toBe(true);
    expect(restrictedAt()).toBeNull();
  });

  it('leaves restricted_at set when any chat failed, so the next onboard retries', async () => {
    sqlite.prepare('UPDATE users SET restricted_at = 123 WHERE telegram_id = ?').run(USER);
    const deps = makeDeps({
      restrictChatMember: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('flaky')),
    });

    const res = await ungateMember(deps, { chatIds: [CHAT_A, CHAT_B], userId: USER });

    expect(res.fullyLifted).toBe(false);
    expect(restrictedAt()).toBe(123);
  });
});
