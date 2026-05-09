import logger from './log.ts';

/** True if real-time / digest publishing is allowed at `now`. */
export function isPublishingEnabled(now: Date = new Date()): boolean {
  const raw = process.env['EVENTS_PUBLISHING_ENABLED_AFTER'];
  if (!raw || raw.trim() === '') return true; // no gate set → publishing on
  const ts = new Date(raw);
  if (isNaN(ts.getTime())) {
    logger.error(
      { module: 'silent-period', value: raw },
      'EVENTS_PUBLISHING_ENABLED_AFTER is not a valid ISO 8601 timestamp — treating as silent (safer default)',
    );
    return false; // fail closed: invalid config means we don't publish
  }
  return now.getTime() >= ts.getTime();
}
