import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Mock the db client so Vitest (Node) doesn't try to import bun:sqlite
const mockRun = vi.fn();
vi.mock('../db/client.ts', () => ({
  db: { run: mockRun },
}));

const { default: healthz } = await import('../api/healthz.ts');

describe('GET /healthz', () => {
  it('returns 200 with { ok: true, db: true } when DB is healthy', async () => {
    mockRun.mockReturnValue(undefined);

    const app = new Hono();
    app.route('/healthz', healthz);

    const res = await app.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; db: boolean };
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
  });

  it('returns 200 with { ok: true, db: false } when DB probe fails', async () => {
    mockRun.mockImplementation(() => {
      throw new Error('DB error');
    });

    const app = new Hono();
    app.route('/healthz', healthz);

    const res = await app.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; db: boolean };
    expect(body.ok).toBe(true);
    expect(body.db).toBe(false);
  });
});
