/**
 * kyiv-week.ts — the one definition of "a week" for everything that buckets
 * play by week.
 *
 * The group's week is not the calendar's. It runs Fri 19:00 Europe/Kyiv → Fri
 * 19:00 Europe/Kyiv, because that is when the weekly digest posts
 * (`0 19 * * 5`, Europe/Kyiv). A match belongs to the window that CLOSES on the
 * first Friday 19:00 strictly after it — the window `buildDigest` aggregates —
 * and that window is named by the ISO week of its closing Friday.
 *
 * This module exists because there were two answers to "which week is this
 * match in". The digest tick used the Fri→Fri window; `records-rebuild.ts`
 * bucketed by ISO Mon–Sun. Both wrote `weekly_records` under the same key, so
 * the 06:30 reconcile rebuild — which fires whenever a member actually leaves —
 * pre-filled the current week's row from a different set of matches, and
 * `upsertWeeklyLeader` only ever raises: the Friday tick then failed to beat
 * its own bar and «👑 Король MVP за неделю» vanished without a trace (owner,
 * 2026-08-09). The arithmetic was duplicated three times over, which is how the
 * two definitions drifted apart in the first place.
 *
 * Pure and dependency-free on purpose: `digest/` and `publisher/` both need it
 * (and `publisher/` must not start importing `digest/`), and
 * `scripts/launch/backfill-records.ts` has to reach it without dragging the
 * digest renderer, croner and the logger into a one-shot script.
 */

const KYIV_TZ = 'Europe/Kyiv';

/**
 * Kyiv wall-clock fields of an instant. `hourCycle: 'h23'` and not
 * `hour12: false` — some ICU builds report midnight as hour "24" under the
 * latter, which would throw the derived offset off by a whole day.
 */
const kyivWallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: KYIV_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Europe/Kyiv's offset from UTC at `ms`, in ms (+2h EET winter, +3h EEST summer). */
export function kyivOffsetMs(ms: number): number {
  const parts = kyivWallClock.formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second'),
  );
  // formatToParts truncates to whole seconds, so compare against the truncated
  // instant — otherwise the sub-second remainder leaks into the offset.
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant `days` Kyiv CALENDAR days from `ms`, at the same local wall-clock
 * time. Deliberately not `ms + days * 86400000`: across a DST change a Kyiv day
 * is 23 or 25 hours long.
 *
 * Two passes — shift the wall clock, convert back with the offset in effect at
 * the source instant, then re-convert if the offset actually in effect at the
 * target differs. A wall-clock time that does not exist (03:00–03:59 on the
 * spring-forward Sunday) keeps the first guess; the digest anchors are Fri
 * 18:45 / 19:00, which never land in the gap.
 */
export function shiftKyivCalendarDays(ms: number, days: number): number {
  const offset = kyivOffsetMs(ms);
  const wall = ms + offset + days * 86400000;
  const firstGuess = wall - offset;
  const targetOffset = kyivOffsetMs(firstGuess);
  if (targetOffset === offset) return firstGuess;
  const secondGuess = wall - targetOffset;
  return kyivOffsetMs(secondGuess) === targetOffset ? secondGuess : firstGuess;
}

const kyivDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const kyivWeekdayName = new Intl.DateTimeFormat('en-US', { timeZone: KYIV_TZ, weekday: 'short' });

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of the week in Kyiv at `ms`: Sun=0 … Sat=6. */
export function kyivWeekday(ms: number): number {
  return WEEKDAY[kyivWeekdayName.format(ms)] ?? 0;
}


/**
 * ISO week string (e.g. "2026-W32") of the Kyiv day containing `ms`, by the
 * standard Thursday-anchor algorithm. This is the NAME of a week, not its
 * boundaries — feed it a window's closing Friday, not a match's `started_at`,
 * whenever the answer keys `weekly_records` or `digest_runs`.
 */
export function computeWeekIso(ms: number): string {
  const parts = kyivDate.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const weekday = kyivWeekday(ms);

  const todayMidnightMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00+03:00`);
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const mondayMs = todayMidnightMs - daysFromMonday * 86400000;

  const thursdayMs = mondayMs + 3 * 86400000;
  const thursdayDate = new Date(thursdayMs);
  const thurYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(thurYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay();
  const jan4Monday = jan4 - (jan4Weekday === 0 ? 6 : jan4Weekday - 1) * 86400000;
  const weekNumber = Math.floor((thursdayMs - jan4Monday) / (7 * 86400000)) + 1;
  return `${thurYear}-W${String(weekNumber).padStart(2, '0')}`;
}

/** The weekly digest cron `0 19 * * 5` (Europe/Kyiv), in the numbers this module needs. */
export const DIGEST_HOUR_KYIV = 19;
const FRIDAY = 5;

/** The instant at `hour`:00:00.000 Kyiv wall clock on the same Kyiv day as `ms`. */
function kyivSameDayAtHour(ms: number, hour: number): number {
  const offset = kyivOffsetMs(ms);
  const wallTarget = Math.floor((ms + offset) / 86400000) * 86400000 + hour * 3600000;
  const firstGuess = wallTarget - offset;
  const targetOffset = kyivOffsetMs(firstGuess);
  if (targetOffset === offset) return firstGuess;
  const secondGuess = wallTarget - targetOffset;
  return kyivOffsetMs(secondGuess) === targetOffset ? secondGuess : firstGuess;
}

/**
 * The end of the digest window a match at `ms` belongs to: the first Friday
 * 19:00 Europe/Kyiv STRICTLY after `ms`.
 *
 * Strictly, because the tick selects `started_at < weekEnd` — a match that
 * starts on the stroke of 19:00 is next week's news.
 *
 * Walks Kyiv calendar days rather than adding `7 * 86400000`: consecutive
 * Fridays are 167h apart across the spring forward and 169h across the autumn
 * back.
 */
export function digestWeekEndFor(ms: number): number {
  const sameDayAt19 = kyivSameDayAtHour(ms, DIGEST_HOUR_KYIV);
  let daysAhead = (FRIDAY - kyivWeekday(ms) + 7) % 7;
  if (daysAhead === 0 && ms >= sameDayAt19) daysAhead = 7;
  return daysAhead === 0 ? sameDayAt19 : shiftKyivCalendarDays(sameDayAt19, daysAhead);
}

/**
 * The `weekly_records.week_iso` key a match at `ms` counts towards — the ISO
 * week of the Friday that closes its window, which is exactly the key
 * `buildDigest` hands `computeAndEmitWeeklyMvpRecord`.
 */
export function digestWeekIsoFor(ms: number): string {
  return computeWeekIso(digestWeekEndFor(ms));
}
