/**
 * scheduled-digest.test.ts — focused test of the shared idempotency contract.
 *
 * Real in-memory SQLite + real migrations (project rule: no DB mocks). This
 * exercises the documented no-dup-on-crash ordering directly against both
 * adapters' tables (`digest_runs` for weekly, `daily_digest_runs` for daily):
 *
 *   - crash-before-send (builder throws) → NO run row, NO post → next tick retries
 *   - crash-after-send (recordSuccess throws / process dies post-send) →
 *     a duplicate post on retry is the *accepted* lesser harm; the contract
 *     guarantees we never silently lose a digest
 *   - happy path → exactly one post + one durable row
 *   - dedup → a recorded row makes the next tick a no-op (no second post)
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { runScheduledDigest, type DigestSpec } from './scheduled-digest.ts';
import { digestRuns } from '../db/schema/digest_runs.ts';
import { dailyDigestRuns } from '../db/schema/daily_digest_runs.ts';

vi.mock('./log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys=OFF;');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

const NOW = 1_746_000_000_000;
const WEEK_ISO = '2026-W19';

/**
 * A weekly-shaped spec backed by `digest_runs`, with an injectable builder
 * so a test can make the build step throw (crash-before-send).
 */
function weeklySpec(
  db: ReturnType<typeof makeTestDb>['db'],
  build: DigestSpec['build'],
  overrides: Partial<DigestSpec> = {},
): DigestSpec {
  return {
    module: 'digest',
    cron: '0 19 * * 5',
    silentPeriodGate: true,
    healthcheckUrl: undefined,
    resolveWindow: () => ({
      nowMs: NOW,
      windowStart: NOW - 7 * 86400000,
      windowEnd: NOW,
      dedupKey: WEEK_ISO,
    }),
    build,
    findExisting: async (d, key) => {
      const [row] = await d
        .select({ id: digestRuns.id })
        .from(digestRuns)
        .where(eq(digestRuns.week_iso, key))
        .limit(1);
      return row;
    },
    recordMarker: async (d, w, marker) => {
      await d
        .insert(digestRuns)
        .values({ week_iso: w.dedupKey, started_at: w.nowMs, posted_text: marker })
        .onConflictDoNothing();
    },
    recordSuccess: async (d, w, sent) => {
      await d
        .insert(digestRuns)
        .values({
          week_iso: w.dedupKey,
          started_at: w.nowMs,
          posted_at: sent.postedAt,
          posted_message_id: sent.messageId,
          posted_text: sent.text,
        })
        .onConflictDoNothing();
    },
    ...overrides,
  };
}

function rowFor(sqlite: Database.Database, weekIso: string) {
  return sqlite.prepare('SELECT * FROM digest_runs WHERE week_iso = ?').get(weekIso) as
    | { id: number; week_iso: string; posted_at: number | null; posted_message_id: number | null; posted_text: string | null }
    | undefined;
}

describe('scheduled-digest idempotency contract (no-dup-on-crash)', () => {
  let db: ReturnType<typeof makeTestDb>['db'];
  let sqlite: Database.Database;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = makeTestDb());
    sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('crash-before-send: builder throws → NO run row, NO post, next tick retries', async () => {
    const flakyBuild = vi
      .fn<DigestSpec['build']>()
      .mockRejectedValueOnce(new Error('builder blew up'))
      .mockResolvedValue({ text: 'recovered content', meta: ['pulse'] });

    const spec = weeklySpec(db, flakyBuild);

    // First tick: build throws BEFORE send.
    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).not.toHaveBeenCalled();
    // The crash must NOT poison the cycle — no row exists.
    expect(rowFor(sqlite, WEEK_ISO)).toBeUndefined();

    // Next cron tick recovers and posts exactly once.
    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).toHaveBeenCalledOnce();
    const row = rowFor(sqlite, WEEK_ISO);
    expect(row?.posted_message_id).toBe(42);
    expect(row?.posted_text).toBe('recovered content');
  });

  it('crash-after-send: recordSuccess throws → message WAS posted, no row; retry re-posts (accepted lesser harm)', async () => {
    const build = vi
      .fn<DigestSpec['build']>()
      .mockResolvedValue({ text: 'the digest', meta: [] });

    const persist: DigestSpec['recordSuccess'] = async (d, w, sent) => {
      await d
        .insert(digestRuns)
        .values({
          week_iso: w.dedupKey,
          started_at: w.nowMs,
          posted_at: sent.postedAt,
          posted_message_id: sent.messageId,
          posted_text: sent.text,
        })
        .onConflictDoNothing();
    };
    const recordSuccess = vi
      .fn<DigestSpec['recordSuccess']>()
      .mockRejectedValueOnce(new Error('db died right after send'))
      .mockImplementation(persist);

    const spec = weeklySpec(db, build, { recordSuccess });

    // First tick: send succeeds, then recordSuccess throws (simulating a
    // crash in the tiny window after the post but before the durable row).
    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    // The message DID go out...
    expect(sendMessage).toHaveBeenCalledOnce();
    // ...but no row was durably written (the crash).
    expect(rowFor(sqlite, WEEK_ISO)).toBeUndefined();

    // Next tick: dedup check finds nothing → re-posts. This duplicate is the
    // explicitly-accepted lesser harm vs. a permanently-lost digest. The
    // contract's guarantee — "never silently lose a digest" — holds. The
    // recovery recordSuccess now persists (mockImplementation fallback).
    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const row = rowFor(sqlite, WEEK_ISO);
    expect(row).toBeDefined();
    expect(row?.posted_message_id).toBe(42);
  });

  it('happy path: exactly one post + one durable row recorded AFTER the send', async () => {
    const order: string[] = [];
    sendMessage.mockImplementation(async () => {
      order.push('send');
      return { message_id: 7 };
    });
    const spec = weeklySpec(
      db,
      async () => ({ text: 'hello', meta: ['pulse'] }),
      {
        recordSuccess: async (d, w, sent) => {
          order.push('record');
          await d
            .insert(digestRuns)
            .values({
              week_iso: w.dedupKey,
              started_at: w.nowMs,
              posted_at: sent.postedAt,
              posted_message_id: sent.messageId,
              posted_text: sent.text,
            })
            .onConflictDoNothing();
        },
      },
    );

    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    // Ordering invariant: send strictly precedes the durable record.
    expect(order).toEqual(['send', 'record']);
    const row = rowFor(sqlite, WEEK_ISO);
    expect(row?.posted_message_id).toBe(7);
  });

  it('dedup: a recorded row makes the next tick a no-op (no second post)', async () => {
    const spec = weeklySpec(db, async () => ({ text: 'once', meta: [] }));

    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });
    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('silent-period gate (weekly): records [silent-period] marker, no post', async () => {
    vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', new Date(NOW + 9_999_999).toISOString());
    const spec = weeklySpec(db, async () => ({ text: 'should not post', meta: [] }));

    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(rowFor(sqlite, WEEK_ISO)?.posted_text).toBe('[silent-period]');
  });

  it('empty content: records [no_content] marker, no post', async () => {
    const spec = weeklySpec(db, async () => ({ text: null, meta: [] }));

    await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(rowFor(sqlite, WEEK_ISO)?.posted_text).toBe('[no_content]');
  });

  describe('Healthchecks.io ping (issue #290)', () => {
    const HC_URL = 'https://hc-ping.test/abc';
    let fetchSpy: MockInstance<typeof fetch>;

    beforeEach(() => {
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));
    });
    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('regular flow: pings after a successful post', async () => {
      const spec = weeklySpec(db, async () => ({ text: 'hi', meta: [] }), {
        healthcheckUrl: HC_URL,
      });

      await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(HC_URL);
    });

    it('publishOverride path: pings when the override returns normally', async () => {
      // Regression for #290: weekly two-phase override (`makeWeeklyPublishOverride`)
      // posts the digest itself and used to bypass step 8, so HC never got a ping
      // even though the digest was sent. The scaffold must ping after the
      // override returns.
      const override = vi.fn<NonNullable<DigestSpec['publishOverride']>>().mockResolvedValue();
      const spec = weeklySpec(db, async () => ({ text: 'unused', meta: [] }), {
        publishOverride: override,
        healthcheckUrl: HC_URL,
      });

      await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

      expect(override).toHaveBeenCalledOnce();
      // The override owns the send — the scaffold must NOT also call sendMessage.
      expect(sendMessage).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(HC_URL);
    });

    it('publishOverride path: does NOT ping if the override throws', async () => {
      const override = vi
        .fn<NonNullable<DigestSpec['publishOverride']>>()
        .mockRejectedValue(new Error('override crashed'));
      const spec = weeklySpec(db, async () => ({ text: 'unused', meta: [] }), {
        publishOverride: override,
        healthcheckUrl: HC_URL,
      });

      await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

      expect(override).toHaveBeenCalledOnce();
      // A crash inside the override must NOT mark Healthchecks green.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('silent-period: does NOT ping (weekly only, override unreached)', async () => {
      vi.stubEnv('EVENTS_PUBLISHING_ENABLED_AFTER', new Date(NOW + 9_999_999).toISOString());
      const override = vi.fn<NonNullable<DigestSpec['publishOverride']>>().mockResolvedValue();
      const spec = weeklySpec(db, async () => ({ text: 'unused', meta: [] }), {
        publishOverride: override,
        healthcheckUrl: HC_URL,
      });

      await runScheduledDigest(spec, { db, sendMessage, getPrimaryChatId: () => -100 });

      expect(override).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('daily-shaped spec (daily_digest_runs, no silent-period): crash-before-send → no row, retry posts', async () => {
    const RUN_DATE = '2026-04-30';
    const build = vi
      .fn<DigestSpec['build']>()
      .mockRejectedValueOnce(new Error('daily build crashed'))
      .mockResolvedValue({ text: '🎯 Ace', meta: [42] });

    const dailySpec: DigestSpec = {
      module: 'digest-daily',
      cron: '0 23 * * *',
      silentPeriodGate: false,
      healthcheckUrl: undefined,
      resolveWindow: () => ({
        nowMs: NOW,
        windowStart: NOW - 24 * 3600 * 1000,
        windowEnd: NOW,
        dedupKey: RUN_DATE,
      }),
      build,
      findExisting: async (d, key) => {
        const [row] = await d
          .select({ id: dailyDigestRuns.id })
          .from(dailyDigestRuns)
          .where(eq(dailyDigestRuns.run_date, key))
          .limit(1);
        return row;
      },
      recordMarker: async (d, w) => {
        await d
          .insert(dailyDigestRuns)
          .values({ run_date: w.dedupKey, started_at: w.nowMs, posted_at: Date.now() })
          .onConflictDoNothing();
      },
      recordSuccess: async (d, w, sent, meta) => {
        await d
          .insert(dailyDigestRuns)
          .values({
            run_date: w.dedupKey,
            started_at: w.nowMs,
            posted_at: sent.postedAt,
            posted_message_id: sent.messageId,
            posted_text: sent.text,
            included_event_ids: JSON.stringify(meta as number[]),
          })
          .onConflictDoNothing();
      },
    };

    const dailyRow = () =>
      sqlite.prepare('SELECT * FROM daily_digest_runs WHERE run_date = ?').get(RUN_DATE) as
        | { posted_message_id: number | null; included_event_ids: string }
        | undefined;

    // Crash-before-send: no row, no post.
    await runScheduledDigest(dailySpec, { db, sendMessage, getPrimaryChatId: () => -100 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(dailyRow()).toBeUndefined();

    // Retry recovers — exactly one post, durable row with included_event_ids.
    await runScheduledDigest(dailySpec, { db, sendMessage, getPrimaryChatId: () => -100 });
    expect(sendMessage).toHaveBeenCalledOnce();
    const row = dailyRow();
    expect(row?.posted_message_id).toBe(42);
    expect(JSON.parse(row?.included_event_ids ?? '[]')).toEqual([42]);
  });
});
