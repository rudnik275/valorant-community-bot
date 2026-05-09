import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import healthz from '../api/healthz.ts';

const app = new Hono();
app.route('/healthz', healthz);

describe('GET /healthz', () => {
  it('returns 200 with { ok: true, db: false }', async () => {
    const res = await app.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, db: false });
  });
});
