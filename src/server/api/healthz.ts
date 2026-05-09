import { Hono } from 'hono';

const healthz = new Hono();

healthz.get('/', (c) => {
  // db: false until schema is added in issue #4
  return c.json({ ok: true, db: false });
});

export default healthz;
