/**
 * reconcile-membership.test.ts — Unit tests for runReconcileMembershipTick.
 *
 * Uses real SQLite (:memory:), PRAGMA foreign_keys=ON.
 * Telegram getChatMember is injected as a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { runReconcileMembershipTick, type ReconcileMembershipDeps } from './reconcile-membership.ts';

vi.mock('../lib/log.ts', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const BOT_ID = 999;
const CHAT_ID = -100100;

function makeDeps(
  db: ReturnType<typeof makeTestDb>['db'],
  overrides: Partial<ReconcileMembershipDeps> = {},
): ReconcileMembershipDeps {
  return {
    db,
    getAllowedChatIds: () => new Set([CHAT_ID]),
    getBotId: () => BOT_ID,
    getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
    rebuildRecords: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runReconcileMembershipTick', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: ReturnType<typeof makeTestDb>['sqlite'];

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
  });

  afterEach(() => {
    sqlite.close();
    vi.resetAllMocks();
  });

  // (a) status: 'left' → member purged, rebuild called
  it('(a) member with status=left → purged and rebuild called', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-left', 'LeftPlayer', 'LP')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'left' });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).toContain(1);
    expect(result.purged).toContain(1);
    expect(rebuildRecords).toHaveBeenCalledOnce();

    // Row should be gone
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=1`).all()).toHaveLength(0);
  });

  // (b) status: 'member' → kept, not purged, rebuild NOT called
  it('(b) member with status=member → kept, rebuild not called', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (2, 'puuid-member', 'ActivePlayer', 'AP')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).not.toContain(2);
    expect(result.purged).not.toContain(2);
    expect(rebuildRecords).not.toHaveBeenCalled();

    // Row should remain
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=2`).all()).toHaveLength(1);
  });

  // (c) restricted + is_member=false → purged
  it('(c) restricted+is_member=false → purged', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (3, 'puuid-restr-out', 'RestrictedOut', 'RO')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'restricted', is_member: false });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).toContain(3);
    expect(result.purged).toContain(3);
    expect(rebuildRecords).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=3`).all()).toHaveLength(0);
  });

  // (d) restricted + is_member=true → kept
  it('(d) restricted+is_member=true → kept, not purged', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (4, 'puuid-restr-in', 'RestrictedIn', 'RI')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'restricted', is_member: true });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).not.toContain(4);
    expect(result.purged).not.toContain(4);
    expect(rebuildRecords).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=4`).all()).toHaveLength(1);
  });

  // (e) safety: getChatMember throws for all chats → member NOT purged, rebuild NOT called
  it('(e) getChatMember throws for all chats → member NOT purged, rebuild NOT called', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (5, 'puuid-err', 'ErrorPlayer', 'EP')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockRejectedValue(new Error('bot not admin'));
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).not.toContain(5);
    expect(result.purged).not.toContain(5);
    expect(rebuildRecords).not.toHaveBeenCalled();
    // User row still present
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=5`).all()).toHaveLength(1);
  });

  // (f) dryRun=true with departed member → returned in departed, NOT deleted, rebuild NOT called
  it('(f) dryRun=true → departed in result but NOT deleted, rebuild NOT called', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (6, 'puuid-dry', 'DryPlayer', 'DP')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'kicked' });
    const deps = makeDeps(db, { getChatMember, rebuildRecords, dryRun: true });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).toContain(6);
    expect(result.purged).toHaveLength(0);
    expect(rebuildRecords).not.toHaveBeenCalled();
    // User row still present (dry-run: no deletion)
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=6`).all()).toHaveLength(1);
  });

  // (g) bot's own telegram_id is skipped entirely
  it('(g) bot own id is skipped — not checked, not purged', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id) VALUES (${BOT_ID})`);

    const getChatMember = vi.fn().mockResolvedValue({ status: 'left' });
    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    // getChatMember should never be called for the bot itself
    expect(getChatMember).not.toHaveBeenCalledWith(CHAT_ID, BOT_ID);
    expect(result.purged).not.toContain(BOT_ID);
    // Bot row still present
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=${BOT_ID}`).all()).toHaveLength(1);
  });

  // Mixed: one departed, one kept — only departed purged, rebuild called once
  it('one departed one kept → only departed purged, rebuild called once', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (7, 'puuid-gone', 'GonePlayer', 'GP')`);
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (8, 'puuid-here', 'HerePlayer', 'HP')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockImplementation((_chatId: number, userId: number) => {
      if (userId === 7) return Promise.resolve({ status: 'left' });
      if (userId === 8) return Promise.resolve({ status: 'administrator' });
      return Promise.resolve({ status: 'member' });
    });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.purged).toContain(7);
    expect(result.purged).not.toContain(8);
    expect(rebuildRecords).toHaveBeenCalledOnce();

    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=7`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=8`).all()).toHaveLength(1);
  });

  // creator status → kept
  it('creator status → kept', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (9, 'puuid-creator', 'Creator', 'CR')`);

    const getChatMember = vi.fn().mockResolvedValue({ status: 'creator' });
    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).not.toContain(9);
    expect(result.purged).not.toContain(9);
    expect(rebuildRecords).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=9`).all()).toHaveLength(1);
  });

  // (h) getChatMember rejects with Telegram 400 "member not found" → treated as
  // DEPARTED (conclusive "not a participant"), purged. Mirrors the real prod case.
  it('(h) 400 member not found → treated as departed and purged', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (11, 'puuid-notfound', 'GhostPlayer', 'GH')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const notFound = Object.assign(new Error("Call to 'getChatMember' failed!"), {
      error_code: 400,
      description: 'Bad Request: member not found',
    });
    const getChatMember = vi.fn().mockRejectedValue(notFound);
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).toContain(11);
    expect(result.purged).toContain(11);
    expect(rebuildRecords).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=11`).all()).toHaveLength(0);
  });

  // (i) a non-"not found" API error (e.g. 429 rate-limit) stays UNKNOWN → NOT purged.
  // Proves the not-found classification is specific and doesn't swallow transient failures.
  it('(i) 429 rate-limit error → unknown, member NOT purged', async () => {
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (12, 'puuid-rl', 'RateLimited', 'RL')`);

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
    });
    const getChatMember = vi.fn().mockRejectedValue(rateLimited);
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.departed).not.toContain(12);
    expect(result.purged).not.toContain(12);
    expect(rebuildRecords).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=12`).all()).toHaveLength(1);
  });

  // (j) orphan sweep: record rows whose puuid is no longer in users get swept even
  // when NO member is purged this tick (e.g. left by the live listener's bare delete),
  // and a rebuild is triggered.
  it('(j) orphaned record rows (puuid not in users) are swept + rebuild called', async () => {
    // A present member (kept)
    sqlite.exec(`INSERT INTO users (telegram_id, riot_puuid, riot_name, riot_tag) VALUES (1, 'puuid-here', 'Here', 'H')`);
    // Orphan rows from a prior out-of-band member removal (puuid not in users) — FK off to insert
    sqlite.exec('PRAGMA foreign_keys=OFF');
    sqlite.exec(`INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES ('mvp_count_week', '2024-W09', 'puuid-ghost', 4)`);
    sqlite.exec(`INSERT INTO all_time_records (record_type, weapon, riot_puuid, value, match_id, achieved_at) VALUES ('kills_match', '', 'puuid-ghost', 40, 'm-ghost', 5000)`);
    sqlite.exec('PRAGMA foreign_keys=ON');

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.purged).toHaveLength(0);
    expect(rebuildRecords).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT * FROM weekly_records WHERE riot_puuid='puuid-ghost'`).all()).toHaveLength(0);
    expect(sqlite.prepare(`SELECT * FROM all_time_records WHERE riot_puuid='puuid-ghost'`).all()).toHaveLength(0);
    // present member kept
    expect(sqlite.prepare(`SELECT * FROM users WHERE telegram_id=1`).all()).toHaveLength(1);
  });

  // (k) safety: with an empty users table the orphan sweep is skipped entirely, so a
  // transient/erroneous empty state can never wipe all records.
  it('(k) empty users table → orphan sweep skipped, records NOT wiped, rebuild not called', async () => {
    sqlite.exec('PRAGMA foreign_keys=OFF');
    sqlite.exec(`INSERT INTO weekly_records (record_type, week_iso, riot_puuid, value) VALUES ('mvp_count_week', '2024-W09', 'puuid-ghost', 4)`);
    sqlite.exec('PRAGMA foreign_keys=ON');

    const rebuildRecords = vi.fn().mockResolvedValue(undefined);
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const deps = makeDeps(db, { getChatMember, rebuildRecords });

    const result = await runReconcileMembershipTick(deps);

    expect(result.purged).toHaveLength(0);
    expect(rebuildRecords).not.toHaveBeenCalled();
    // orphan NOT wiped — the empty-users guard protected the table
    expect(sqlite.prepare(`SELECT * FROM weekly_records WHERE riot_puuid='puuid-ghost'`).all()).toHaveLength(1);
  });
});
