/**
 * henrik-queue.ts — Priority + dedup queue in front of Henrik API calls.
 *
 * Two priority levels:
 *   - `interactive` — user-facing requests (onboarding, /api/*). Jumps the queue.
 *   - `background` — cron sweeps, opponent peak lookups.
 *
 * Single worker. Dedup by key: enqueueing a task whose key is already in flight
 * or queued attaches a new awaiter to the existing task; only one HTTP call is
 * made. If a `background` task is re-enqueued as `interactive`, the queued task
 * is promoted (moved to the interactive sub-queue).
 *
 * Rate limiting (token bucket in henrik.ts) is unchanged — this layer handles
 * ordering and dedup, the bucket handles rate.
 */
export type Priority = 'interactive' | 'background';

interface Task<T = unknown> {
  key: string;
  priority: Priority;
  fn: () => Promise<T>;
  enqueuedAt: number;
  callbacks: Array<{
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
  }>;
}

export interface QueueStats {
  pendingInteractive: number;
  pendingBackground: number;
  oldestPendingAgeMs: number;
}

export class HenrikQueue {
  private interactive: Task[] = [];
  private background: Task[] = [];
  /** Maps key → currently-queued-or-inflight task, for dedup. */
  private byKey = new Map<string, Task>();
  private running = false;

  enqueue<T>(opts: {
    key: string;
    priority?: Priority;
    fn: () => Promise<T>;
  }): Promise<T> {
    const priority: Priority = opts.priority ?? 'background';

    const existing = this.byKey.get(opts.key) as Task<T> | undefined;
    if (existing) {
      if (priority === 'interactive' && existing.priority === 'background') {
        existing.priority = 'interactive';
        const idx = this.background.indexOf(existing as Task);
        if (idx >= 0) {
          this.background.splice(idx, 1);
          this.interactive.push(existing as Task);
        }
      }
      return new Promise<T>((resolve, reject) => {
        existing.callbacks.push({ resolve, reject });
      });
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = {
        key: opts.key,
        priority,
        fn: opts.fn,
        enqueuedAt: Date.now(),
        callbacks: [{ resolve, reject }],
      };
      this.byKey.set(opts.key, task as Task);
      (priority === 'interactive' ? this.interactive : this.background).push(task as Task);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.interactive.length > 0 || this.background.length > 0) {
        const task = this.interactive.shift() ?? this.background.shift();
        if (!task) break;
        try {
          const result = await task.fn();
          for (const cb of task.callbacks) cb.resolve(result);
        } catch (err) {
          for (const cb of task.callbacks) cb.reject(err);
        } finally {
          this.byKey.delete(task.key);
        }
      }
    } finally {
      this.running = false;
    }
  }

  stats(): QueueStats {
    const all = [...this.interactive, ...this.background];
    const oldest = all.reduce((min, t) => Math.min(min, t.enqueuedAt), Date.now());
    return {
      pendingInteractive: this.interactive.length,
      pendingBackground: this.background.length,
      oldestPendingAgeMs: all.length > 0 ? Date.now() - oldest : 0,
    };
  }
}

export const henrikQueue = new HenrikQueue();

/** Reset queue state — tests only. */
export function __resetHenrikQueueForTest(): void {
  const q = henrikQueue as unknown as {
    interactive: Task[];
    background: Task[];
    byKey: Map<string, Task>;
    running: boolean;
  };
  q.interactive = [];
  q.background = [];
  q.byKey = new Map();
  q.running = false;
}
