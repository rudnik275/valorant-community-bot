import { describe, it, expect, beforeEach } from 'vitest';
import { HenrikQueue } from './henrik-queue.ts';

/** Promise whose resolve/reject is exposed for test orchestration. */
function controlled<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield to the event loop so queued microtasks/promises drain. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('HenrikQueue', () => {
  let q: HenrikQueue;

  beforeEach(() => {
    q = new HenrikQueue();
  });

  it('runs a single task and resolves with its value', async () => {
    const result = await q.enqueue({ key: 'k1', fn: () => Promise.resolve(42) });
    expect(result).toBe(42);
  });

  it('serializes execution — second task only starts after first completes', async () => {
    const order: string[] = [];
    const gate1 = controlled<void>();
    const gate2 = controlled<void>();

    const p1 = q.enqueue({
      key: 'k1',
      fn: async () => {
        order.push('start1');
        await gate1.promise;
        order.push('end1');
      },
    });
    const p2 = q.enqueue({
      key: 'k2',
      fn: async () => {
        order.push('start2');
        await gate2.promise;
        order.push('end2');
      },
    });

    await flush();
    expect(order).toEqual(['start1']); // k2 has not started yet

    gate1.resolve();
    await flush();
    expect(order).toEqual(['start1', 'end1', 'start2']);

    gate2.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('runs interactive tasks before background tasks', async () => {
    const order: string[] = [];
    const blocker = controlled<void>();

    // First task blocks the worker so subsequent enqueues queue up.
    q.enqueue({
      key: 'block',
      fn: async () => {
        order.push('block');
        await blocker.promise;
      },
    });
    await flush();

    // Pile up: bg1, bg2, int1, bg3, int2
    q.enqueue({ key: 'bg1', priority: 'background', fn: async () => { order.push('bg1'); } });
    q.enqueue({ key: 'bg2', priority: 'background', fn: async () => { order.push('bg2'); } });
    q.enqueue({ key: 'int1', priority: 'interactive', fn: async () => { order.push('int1'); } });
    q.enqueue({ key: 'bg3', priority: 'background', fn: async () => { order.push('bg3'); } });
    q.enqueue({ key: 'int2', priority: 'interactive', fn: async () => { order.push('int2'); } });

    blocker.resolve();
    await flush(20);

    // After the blocker, interactive tasks drain first (FIFO inside priority),
    // then background tasks (FIFO).
    expect(order).toEqual(['block', 'int1', 'int2', 'bg1', 'bg2', 'bg3']);
  });

  it('deduplicates concurrent enqueues with the same key — only one fn call, all awaiters get the same result', async () => {
    let callCount = 0;
    const gate = controlled<number>();
    const fn = () => {
      callCount++;
      return gate.promise;
    };

    const p1 = q.enqueue({ key: 'same', fn });
    const p2 = q.enqueue({ key: 'same', fn });
    const p3 = q.enqueue({ key: 'same', fn });

    await flush();
    expect(callCount).toBe(1);

    gate.resolve(123);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe(123);
    expect(r2).toBe(123);
    expect(r3).toBe(123);
    expect(callCount).toBe(1);
  });

  it('propagates rejection to all dedup awaiters', async () => {
    const gate = controlled<number>();
    const p1 = q.enqueue({ key: 'fail', fn: () => gate.promise });
    const p2 = q.enqueue({ key: 'fail', fn: () => gate.promise });

    gate.reject(new Error('boom'));

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
  });

  it('after a task finishes (success), a new enqueue with same key triggers a fresh fn call', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(calls);
    };

    const first = await q.enqueue({ key: 'k', fn });
    const second = await q.enqueue({ key: 'k', fn });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });

  it('promotes a queued background task to interactive when same key is re-enqueued as interactive', async () => {
    const order: string[] = [];
    const blocker = controlled<void>();

    q.enqueue({
      key: 'block',
      fn: async () => {
        order.push('block');
        await blocker.promise;
      },
    });
    await flush();

    // Background tasks queued
    q.enqueue({ key: 'X', priority: 'background', fn: async () => { order.push('X'); } });
    q.enqueue({ key: 'other-bg', priority: 'background', fn: async () => { order.push('other-bg'); } });

    expect(q.stats().pendingInteractive).toBe(0);
    expect(q.stats().pendingBackground).toBe(2);

    // Now re-enqueue same key X as interactive — should be promoted
    const promoted = q.enqueue({ key: 'X', priority: 'interactive', fn: async () => { order.push('X-new-fn'); } });

    expect(q.stats().pendingInteractive).toBe(1);
    expect(q.stats().pendingBackground).toBe(1);

    blocker.resolve();
    await promoted;
    await flush(10);

    // X (interactive) runs before other-bg. Original fn is used (dedup).
    expect(order).toEqual(['block', 'X', 'other-bg']);
  });

  it('stats() reflects current queue depth and oldest age', async () => {
    const blocker = controlled<void>();
    q.enqueue({ key: 'block', fn: async () => { await blocker.promise; } });
    await flush();

    q.enqueue({ key: 'a', priority: 'background', fn: () => Promise.resolve() });
    q.enqueue({ key: 'b', priority: 'interactive', fn: () => Promise.resolve() });

    const s = q.stats();
    expect(s.pendingBackground).toBe(1);
    expect(s.pendingInteractive).toBe(1);
    expect(s.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);

    blocker.resolve();
    await flush(10);
    expect(q.stats()).toEqual({
      pendingInteractive: 0,
      pendingBackground: 0,
      oldestPendingAgeMs: 0,
    });
  });
});
