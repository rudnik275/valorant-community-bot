/**
 * tests/e2e/onboarding.spec.ts
 *
 * E2E test for the onboarding endpoint during the Henrik -> Riot+RSO
 * transition (issue #41). The previous Henrik-driven flow is gone; the
 * endpoint is a stub that always returns 503 { error: 'rso_pending' }.
 * The full RSO flow lands in issue #43 with its own e2e suite that
 * exercises OAuth state, code exchange (Mock + Riot providers), and the
 * post-callback redirect path.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { makeOnboardHandler } from '../../src/server/api/onboard.ts';
import type { TelegramUser } from '../../src/server/lib/init-data.ts';

vi.mock('../../src/server/lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function buildApp() {
  const app = new Hono();
  app.use('/api/onboard', async (c, next) => {
    const telegramUser: TelegramUser = { id: 7777, first_name: 'E2E', username: 'e2e' };
    c.set('telegramUser', telegramUser);
    await next();
  });
  app.post('/api/onboard', makeOnboardHandler({}));
  return app;
}

async function postOnboard(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/onboard (RSO-pending stub) — e2e', () => {
  it('returns 503 with { error: "rso_pending" } for any valid-shaped body', async () => {
    const app = buildApp();
    const res = await postOnboard(app, { name: 'AnyName', tag: 'EU1' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rso_pending');
  });

  it('returns 503 even for malformed bodies (no validation, no Henrik calls)', async () => {
    const app = buildApp();
    const res = await postOnboard(app, { not: 'a real body' });

    expect(res.status).toBe(503);
  });
});
