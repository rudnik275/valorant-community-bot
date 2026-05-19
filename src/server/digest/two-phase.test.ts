import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { runDigestNow } from './loop.ts';
import { runPrepareTick } from './two-phase.ts';
import type { DigestNowKyiv } from './loop.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock buildDigest so loop tests don't depend on DB match/event data.
vi.mock('./build.ts', () => ({
  buildDigest: vi.fn().mockResolvedValue({
    text: '📅 <b>Дайджест недели</b>\n\nTest content',
    sectionsIncluded: ['pulse'],
    topAgent: 'Jett',
    topMap: 'Ascent',
  }),
}));

// Mock the OpenAI/sharp generation — we never hit the network or disk for refs.
vi.mock('../story/run.ts', () => ({
  runStoryGeneration: vi.fn(),
}));

// node:fs/promises — intercept the PNG stash + the publish-side readback.
const fsState: { files: Map<string, Buffer> } = { files: new Map() };
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(async (path: string, buf: Buffer) => {
    fsState.files.set(path, buf);
  }),
  readFile: vi.fn(async (path: string) => {
    const f = fsState.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f;
  }),
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const FIXED_NOW = 1_746_000_000_000;
const FIXED_WEEK_ISO = '2026-W19';

const DEFAULT_KYIV: DigestNowKyiv = {
  nowMs: FIXED_NOW,
  weekIso: FIXED_WEEK_ISO,
  weekStart: FIXED_NOW - 7 * 86400000,
  weekEnd: FIXED_NOW,
};

interface Row {
  id: number;
  week_iso: string;
  posted_at: number | null;
  posted_message_id: number | null;
  posted_text: string | null;
  prepared_text: string | null;
  prepared_top_agent: string | null;
  prepared_top_map: string | null;
  story_image_path: string | null;
}

function getRow(sqlite: Database.Database, weekIso: string): Row | undefined {
  return sqlite.prepare('SELECT * FROM digest_runs WHERE week_iso = ?').get(weekIso) as
    | Row
    | undefined;
}

describe('two-phase weekly digest (#227)', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;
  let sendPhotoReply: ReturnType<typeof vi.fn>;
  const STORIES_DIR = '/tmp/test-stories';

  beforeEach(async () => {
    ({ db, sqlite } = makeTestDb());
    fsState.files.clear();
    sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    sendPhotoReply = vi.fn().mockResolvedValue(undefined);
    process.env['STORIES_DIR'] = STORIES_DIR;

    const { buildDigest } = await import('./build.ts');
    (buildDigest as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: '📅 <b>Дайджест недели</b>\n\nTest content',
      sectionsIncluded: ['pulse'],
      topAgent: 'Jett',
      topMap: 'Ascent',
    });
    const { runStoryGeneration } = await import('../story/run.ts');
    (runStoryGeneration as ReturnType<typeof vi.fn>).mockResolvedValue({
      buffer: Buffer.from('png-bytes'),
    });
  });

  afterEach(() => {
    sqlite.close();
    delete process.env['STORIES_DIR'];
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  function prepareDeps() {
    return {
      db,
      getPrimaryChatId: () => -1001234567890,
      getOpenAIKey: () => 'sk-test',
      getNowKyiv: () => DEFAULT_KYIV,
    };
  }

  function publishDeps() {
    return {
      db,
      sendMessage,
      getPrimaryChatId: () => -1001234567890,
      getNowKyiv: () => DEFAULT_KYIV,
      sendPhotoReply,
    };
  }

  // ── Scenario 1 — prepared → published happy path ──────────────────────────
  it('prepare writes prepared+story_image_path; publish posts saved text + photo reply; row published', async () => {
    await runPrepareTick(prepareDeps());

    let row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row).toBeDefined();
    expect(row?.prepared_text).toContain('Дайджест');
    expect(row?.prepared_top_agent).toBe('Jett');
    expect(row?.prepared_top_map).toBe('Ascent');
    expect(row?.story_image_path).toBe(`${STORIES_DIR}/${FIXED_WEEK_ISO}.png`);
    expect(row?.posted_at).toBeNull(); // not published yet

    await runDigestNow(publishDeps());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      expect.stringContaining('Дайджест'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    // Photo reply best-effort, on the digest message.
    expect(sendPhotoReply).toHaveBeenCalledOnce();
    expect(sendPhotoReply).toHaveBeenCalledWith(
      -1001234567890,
      expect.any(Buffer),
      `${FIXED_WEEK_ISO}.png`,
      42,
    );

    row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_at).not.toBeNull();
    expect(row?.posted_message_id).toBe(42);
    expect(row?.posted_text).toBe(row?.prepared_text); // saved text posted verbatim
  });

  // ── Scenario 2 — OpenAI fail on prepare ───────────────────────────────────
  it('OpenAI fail on prepare → prepared row without story_image_path; publish posts text only; published', async () => {
    const { runStoryGeneration } = await import('../story/run.ts');
    (runStoryGeneration as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('OpenAI 500'),
    );

    await runPrepareTick(prepareDeps());

    let row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.prepared_text).toContain('Дайджест');
    expect(row?.story_image_path).toBeNull(); // image gave up silently
    // retried MAX 2 times
    expect(runStoryGeneration).toHaveBeenCalledTimes(2);

    await runDigestNow(publishDeps());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhotoReply).not.toHaveBeenCalled(); // no image → no photo
    row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_at).not.toBeNull();
    expect(row?.posted_text).toBe(row?.prepared_text);
  });

  it('missing reference PNG on prepare → prepared row, no image, no retry; publish text-only', async () => {
    const { runStoryGeneration } = await import('../story/run.ts');
    (runStoryGeneration as ReturnType<typeof vi.fn>).mockResolvedValue({
      buffer: null,
      skipReason: 'missing_agent_ref',
    });

    await runPrepareTick(prepareDeps());

    const row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.prepared_text).toContain('Дайджест');
    expect(row?.story_image_path).toBeNull();
    expect(runStoryGeneration).toHaveBeenCalledOnce(); // not retried — not an error

    await runDigestNow(publishDeps());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhotoReply).not.toHaveBeenCalled();
  });

  it('no OPENAI_API_KEY on prepare → prepared row, image skipped; publish text-only', async () => {
    const { runStoryGeneration } = await import('../story/run.ts');

    await runPrepareTick({ ...prepareDeps(), getOpenAIKey: () => '' });

    const row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.prepared_text).toContain('Дайджест');
    expect(row?.story_image_path).toBeNull();
    expect(runStoryGeneration).not.toHaveBeenCalled();

    await runDigestNow(publishDeps());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhotoReply).not.toHaveBeenCalled();
  });

  // ── Scenario 3 — prepare tick skipped ─────────────────────────────────────
  it('prepare tick skipped → publish: no row → fresh build, text only, no image', async () => {
    expect(getRow(sqlite, FIXED_WEEK_ISO)).toBeUndefined();

    await runDigestNow(publishDeps());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhotoReply).not.toHaveBeenCalled();
    const row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_at).not.toBeNull();
    expect(row?.posted_message_id).toBe(42);
    expect(row?.prepared_text).toBeNull(); // never prepared
  });

  // ── Scenario 4 — idempotency ──────────────────────────────────────────────
  it('double prepare is idempotent — second tick is a no-op', async () => {
    await runPrepareTick(prepareDeps());
    const { runStoryGeneration } = await import('../story/run.ts');
    const callsAfterFirst = (runStoryGeneration as ReturnType<typeof vi.fn>).mock.calls.length;

    await runPrepareTick(prepareDeps());

    // No second generation, single prepared row.
    expect((runStoryGeneration as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirst,
    );
    const rows = sqlite
      .prepare('SELECT COUNT(*) AS c FROM digest_runs WHERE week_iso = ?')
      .get(FIXED_WEEK_ISO) as { c: number };
    expect(rows.c).toBe(1);
  });

  it('double publish is idempotent — second tick does not re-post', async () => {
    await runPrepareTick(prepareDeps());
    await runDigestNow(publishDeps());
    await runDigestNow(publishDeps());

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendPhotoReply).toHaveBeenCalledOnce();
  });

  it('publish then prepare-in-same-week is a no-op (published wins)', async () => {
    await runPrepareTick(prepareDeps());
    await runDigestNow(publishDeps());
    const { runStoryGeneration } = await import('../story/run.ts');
    const before = (runStoryGeneration as ReturnType<typeof vi.fn>).mock.calls.length;

    await runPrepareTick(prepareDeps());
    expect((runStoryGeneration as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  // ── photo-reply failure must NOT touch published state (#255 / inv #2) ─────
  it('photo-reply failure leaves the digest published (image is additive)', async () => {
    await runPrepareTick(prepareDeps());
    sendPhotoReply.mockRejectedValueOnce(new Error('Telegram 500 on sendPhoto'));

    await runDigestNow(publishDeps());

    const row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_at).not.toBeNull();
    expect(row?.posted_message_id).toBe(42);

    // A re-run is a clean no-op — text already published, not re-sent.
    await runDigestNow(publishDeps());
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  // ── empty week recorded at prepare → publish posts nothing ────────────────
  it('no_content week: prepare records marker, publish posts nothing', async () => {
    const { buildDigest } = await import('./build.ts');
    (buildDigest as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: null,
      sectionsIncluded: [],
      topAgent: null,
      topMap: null,
    });

    await runPrepareTick(prepareDeps());
    let row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_text).toBe('[no_content]');
    expect(row?.prepared_text).toBeNull();

    await runDigestNow(publishDeps());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendPhotoReply).not.toHaveBeenCalled();
    row = getRow(sqlite, FIXED_WEEK_ISO);
    expect(row?.posted_at).toBeNull();
  });

  // ── silent period at publish (gate runs before the override) ──────────────
  it('silent period at publish → posts nothing, prepared row left untouched', async () => {
    await runPrepareTick(prepareDeps());
    const future = new Date(FIXED_NOW + 999999999).toISOString();
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', future);

    await runDigestNow(publishDeps());

    // The Silent-period gate (weekly silentPeriodGate:true) runs in the
    // shared scaffold BEFORE the publishOverride — nothing is posted.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendPhotoReply).not.toHaveBeenCalled();
    const row = getRow(sqlite, FIXED_WEEK_ISO);
    // The recordMarker insert is onConflictDoNothing; the prepared row
    // already owns this weekIso, so it is left intact (not published).
    expect(row?.prepared_text).toContain('Дайджест');
    expect(row?.posted_at).toBeNull();
  });
});

// ── HARD INVARIANT #1 — daily digest behaviour is unaffected ────────────────
describe('daily digest regression guard (#227 must not regress daily)', () => {
  it('the daily runner still uses the shared no-dup-on-crash path (no two-phase override)', async () => {
    // The two-phase override is wired ONLY into the weekly spec (via
    // sendPhotoReply). The daily loop builds its own DigestSpec with no
    // publishOverride, so it must keep the documented shared behaviour:
    // a zero-ace day records a daily_digest_runs row and sends nothing.
    const { runDailyDigestNow } = await import('../digest-daily/loop.ts');

    const sqlite2 = new Database(':memory:');
    sqlite2.exec('PRAGMA foreign_keys=OFF;');
    const db2 = drizzle(sqlite2);
    migrate(db2, { migrationsFolder: MIGRATIONS_FOLDER });

    const send = vi.fn().mockResolvedValue({ message_id: 7 });
    // Empty DB → buildDailyAceDigest yields no text → marker row, no send.
    await runDailyDigestNow({ db: db2, sendMessage: send, getPrimaryChatId: () => -100 });

    expect(send).not.toHaveBeenCalled();
    const row = sqlite2
      .prepare('SELECT * FROM daily_digest_runs LIMIT 1')
      .get() as { posted_at: number | null; posted_text: string | null } | undefined;
    // Shared no-dup-on-crash + daily semantics: row recorded (posted_at set),
    // no message text. Identical to pre-#227 behaviour.
    expect(row).toBeDefined();
    expect(row?.posted_at).not.toBeNull();
    expect(row?.posted_text).toBeNull();

    // Second tick same day is a no-op (dedup) — still no send.
    await runDailyDigestNow({ db: db2, sendMessage: send, getPrimaryChatId: () => -100 });
    expect(send).not.toHaveBeenCalled();
    sqlite2.close();
  });
});
