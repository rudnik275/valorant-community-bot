import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { makeAuthMiddleware } from './auth.ts';
import { InvalidInitDataError } from '../lib/init-data.ts';
import type { TelegramUser } from '../lib/init-data.ts';

const MOCK_USER: TelegramUser = {
  id: 42,
  username: 'alice',
  first_name: 'Alice',
};

function makeApp(verify: (raw: string) => TelegramUser) {
  const app = new Hono();
  app.use('/api/*', makeAuthMiddleware({ verify }));
  app.get('/api/me', (c) => {
    const user = c.get('telegramUser');
    return c.json({ id: user.id, username: user.username });
  });
  return app;
}

describe('makeAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unauthorized');
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with "tma "', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'Bearer somejwt' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when verify throws InvalidInitDataError', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockImplementation(() => {
      throw new InvalidInitDataError('bad signature');
    });
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'tma invalid.raw.data' },
    });
    expect(res.status).toBe(401);
  });

  it('calls verify with the raw initData (after "tma ") and passes user downstream on success', async () => {
    const verify = vi.fn<(raw: string) => TelegramUser>().mockReturnValue(MOCK_USER);
    const app = makeApp(verify);
    const res = await app.request('/api/me', {
      headers: { Authorization: 'tma raw_init_data_here' },
    });
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('raw_init_data_here');
    const body = await res.json() as { id: number; username: string };
    expect(body.id).toBe(42);
    expect(body.username).toBe('alice');
  });
});
