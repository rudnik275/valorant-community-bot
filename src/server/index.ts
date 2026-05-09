import { Hono } from 'hono';
import logger from './lib/log.ts';
import healthz from './api/healthz.ts';

const PORT = Number(process.env['PORT'] ?? 3000);

const app = new Hono();

// Routes
app.route('/healthz', healthz);

// TODO: bot — mount grammY webhook handler here (#5)
// TODO: scanner — start scan-tick croner job here (#6)
// TODO: publisher — start publisher-tick croner job here (#9)
// TODO: digest — schedule weekly digest here (#11)

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info({ module: 'startup' }, 'SIGTERM received — shutting down gracefully');
  process.exit(0);
});

logger.info({ module: 'startup', port: PORT }, 'Server starting');

export default {
  port: PORT,
  fetch: app.fetch,
};
