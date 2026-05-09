import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import logger from '../lib/log.ts';

const healthz = new Hono();

healthz.get('/', (c) => {
  let dbOk = false;
  try {
    db.run(sql`SELECT 1`);
    dbOk = true;
  } catch (err) {
    logger.error({ module: 'healthz', err }, 'DB probe failed');
  }
  return c.json({ ok: true, db: dbOk });
});

export default healthz;
