/**
 * kyiv-week.test.ts — the shared definition of "a week" has to agree with the
 * cron that actually closes the window, on every digest including the ones DST
 * moves and the Friday→Sunday switch.
 */
import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import {
  computeWeekIso,
  digestWeekEndFor,
  digestWeekIsoFor,
  digestWeekStartFor,
  FIRST_SUNDAY_DIGEST_MS,
  LAST_FRIDAY_DIGEST_MS,
  WEEKLY_DIGEST_CRON,
} from './kyiv-week.ts';

/** The cron the digest posted on until the switch. */
const FRIDAY_DIGEST_CRON = '0 19 * * 5';

/**
 * The instants the weekly digest really closed / closes on, straight from
 * croner: Friday ticks up to the last Friday digest, Sunday ticks from the
 * first Sunday digest on.
 */
function digestTicks(fromMs: number, count: number): number[] {
  const fridays = new Cron(FRIDAY_DIGEST_CRON, { timezone: 'Europe/Kyiv' })
    .nextRuns(count, new Date(fromMs))
    .map((d) => d.getTime())
    .filter((t) => t <= LAST_FRIDAY_DIGEST_MS);
  const sundays = new Cron(WEEKLY_DIGEST_CRON, { timezone: 'Europe/Kyiv' })
    .nextRuns(count - fridays.length, new Date(Math.max(fromMs, FIRST_SUNDAY_DIGEST_MS - 1)))
    .map((d) => d.getTime());
  return [...fridays, ...sundays];
}

describe('the Friday→Sunday switch', () => {
  it('pins the last Friday and first Sunday digests to the instants croner fired / fires on', () => {
    // Fri 2026-10-02 19:00 and Sun 2026-10-11 19:00 Kyiv (EEST, UTC+3).
    expect(new Cron(FRIDAY_DIGEST_CRON, { timezone: 'Europe/Kyiv' })
      .nextRun(new Date(Date.UTC(2026, 9, 1)))!.getTime()).toBe(LAST_FRIDAY_DIGEST_MS);
    expect(new Cron(WEEKLY_DIGEST_CRON, { timezone: 'Europe/Kyiv' })
      .nextRun(new Date(Date.UTC(2026, 9, 5)))!.getTime()).toBe(FIRST_SUNDAY_DIGEST_MS);
  });

  it('files the weekend after the last Friday digest under the FIRST Sunday, not Sun 2026-10-04', () => {
    // There was no digest on Sun 2026-10-04: the play between the two schedules
    // is one nine-day window, or it would fall out of every digest.
    const justBeforeLastFriday = LAST_FRIDAY_DIGEST_MS - 1;
    const onLastFriday = LAST_FRIDAY_DIGEST_MS;
    const saturday = Date.UTC(2026, 9, 3, 18); // Sat 2026-10-03, 21:00 Kyiv
    const sundayEvening = Date.UTC(2026, 9, 4, 17); // Sun 2026-10-04, 20:00 Kyiv
    const thursday = Date.UTC(2026, 9, 8, 18); // Thu 2026-10-08
    expect(digestWeekEndFor(justBeforeLastFriday)).toBe(LAST_FRIDAY_DIGEST_MS);
    for (const ms of [onLastFriday, saturday, sundayEvening, thursday, FIRST_SUNDAY_DIGEST_MS - 1]) {
      expect(digestWeekEndFor(ms), `probe ${ms}`).toBe(FIRST_SUNDAY_DIGEST_MS);
    }
    expect(digestWeekIsoFor(saturday)).toBe('2026-W41');
  });

  it('opens the first Sunday window at the last Friday digest, every later one 7 days back', () => {
    expect(digestWeekStartFor(FIRST_SUNDAY_DIGEST_MS)).toBe(LAST_FRIDAY_DIGEST_MS);
    // The prepare tick builds at 18:45 — it must reach back just as far.
    expect(digestWeekStartFor(FIRST_SUNDAY_DIGEST_MS - 15 * 60000)).toBe(LAST_FRIDAY_DIGEST_MS);
    const secondSunday = Date.UTC(2026, 9, 18, 16);
    expect(digestWeekStartFor(secondSunday)).toBe(FIRST_SUNDAY_DIGEST_MS);
    // Before the switch nothing changes.
    expect(digestWeekStartFor(LAST_FRIDAY_DIGEST_MS)).toBe(LAST_FRIDAY_DIGEST_MS - 7 * 86400000);
  });
});

describe('digestWeekEndFor', () => {
  it('lands exactly on the cron tick that closes the window, for two years of digests', () => {
    // The window a match belongs to is the one the digest closes, so this
    // helper must return an instant croner actually fires on — never a naive
    // +7×24h step, which drifts by an hour twice a year.
    const ticks = digestTicks(Date.UTC(2026, 0, 1), 104);
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1]!;
      const next = ticks[i]!;
      // Probe the whole window: just after it opens, in the middle, and just
      // before it closes.
      for (const probe of [prev + 1, Math.floor((prev + next) / 2), next - 1]) {
        expect(digestWeekEndFor(probe), `probe ${probe} between ticks ${i - 1}/${i}`).toBe(next);
      }
      // A match starting on the stroke of 19:00 is next week's news — the tick
      // selects `started_at < weekEnd`.
      expect(digestWeekEndFor(next)).toBeGreaterThan(next);
    }
  });

  it('handles DST on both schedules, where the week is 167h or 169h long', () => {
    // Fridays: spring 2026. Sundays: autumn 2026 and spring 2027 — the Sunday
    // digest lands on the very day the clocks change.
    const fridaySpring = [Date.UTC(2026, 2, 27, 17), Date.UTC(2026, 3, 3, 16)];
    const sundayAutumn = [Date.UTC(2026, 9, 18, 16), Date.UTC(2026, 9, 25, 17)];
    const sundaySpring = [Date.UTC(2027, 2, 21, 17), Date.UTC(2027, 2, 28, 16)];
    for (const [prev, next] of [fridaySpring, sundayAutumn, sundaySpring]) {
      // The naive step would land an hour off.
      expect(prev! + 7 * 86400000).not.toBe(next);
      expect(digestWeekEndFor(prev! + 1)).toBe(next);
    }
    expect(fridaySpring[1]! - fridaySpring[0]!).toBe(167 * 3600000);
    expect(sundayAutumn[1]! - sundayAutumn[0]!).toBe(169 * 3600000);
    expect(sundaySpring[1]! - sundaySpring[0]!).toBe(167 * 3600000);
  });

  it('files a Saturday match under the FOLLOWING digest, not its own ISO week', () => {
    // This is the whole bug: the group plays weekends, and ISO Mon–Sun put that
    // play in the week that had already been published (Friday schedule).
    const saturday = Date.UTC(2026, 7, 1, 18); // Sat 2026-08-01, 21:00 Kyiv
    expect(computeWeekIso(saturday)).toBe('2026-W31');
    expect(digestWeekIsoFor(saturday)).toBe('2026-W32');
  });

  it('files a Sunday-evening match after the post under the NEXT Sunday', () => {
    const sundayAfterPost = Date.UTC(2026, 9, 18, 17); // Sun 2026-10-18, 20:00 Kyiv
    expect(computeWeekIso(sundayAfterPost)).toBe('2026-W42');
    expect(digestWeekIsoFor(sundayAfterPost)).toBe('2026-W43');
  });

  it('names each window distinctly across two years', () => {
    const ticks = digestTicks(Date.UTC(2026, 0, 1), 104);
    const names = ticks.map((t) => digestWeekIsoFor(t - 1));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('digestWeekStartFor', () => {
  it('every window opens exactly where the previous one closed, for two years of digests', () => {
    // No hour is ever aggregated twice and none is ever skipped — DST or the
    // Friday→Sunday switch.
    const ticks = digestTicks(Date.UTC(2026, 0, 1), 104);
    for (let i = 1; i < ticks.length; i++) {
      expect(digestWeekStartFor(ticks[i]!), `tick ${i}`).toBe(ticks[i - 1]);
    }
  });
});
