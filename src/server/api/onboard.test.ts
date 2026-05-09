import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { makeOnboardHandler } from './onboard.ts';
import type { TelegramUser } from '../lib/init-data.ts';

// During the Henrik -> Riot+RSO transition (issue #41), POST /api/onboard
// always returns 503 { error: 'rso_pending' }. The previous Henrik-driven
// onboarding tests were retired alongside the Henrik integration; the
// full RSO flow ships in issue #43 with its own dedicated tests.

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeApp() {
  const app = new Hono();
  app.use('/api/onboard', async (c, next) => {
    const telegramUser: TelegramUser = { id: 42, first_name: 'Test' };
    c.set('telegramUser', telegramUser);
    await next();
  });
  // Pass an empty deps bag — the stub ignores it.
  app.post('/api/onboard', makeOnboardHandler({}));
  return app;
}

describe('POST /api/onboard (RSO-pending stub)', () => {
  it('returns 503 with { error: "rso_pending" } regardless of body', async () => {
    const app = makeApp();
    const res = await app.request('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AnyName', tag: 'EU1' }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rso_pending');
  });

  it('returns 503 even on empty body (no validation, no Henrik calls)', async () => {
    const app = makeApp();
    const res = await app.request('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(503);
  });
});
