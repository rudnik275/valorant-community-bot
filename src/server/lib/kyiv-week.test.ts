/**
 * kyiv-week.test.ts — the shared definition of "a week" has to agree with the
 * cron that actually closes the window, on every Friday including the two that
 * DST moves.
 */
import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import { computeWeekIso, digestWeekEndFor, digestWeekIsoFor } from './kyiv-week.ts';

/** The instants croner really fires the weekly digest on. */
function weeklyCronTicks(fromMs: number, count: number): number[] {
  return new Cron('0 19 * * 5', { timezone: 'Europe/Kyiv' })
    .nextRuns(count, new Date(fromMs))
    .map((d) => d.getTime());
}

describe('digestWeekEndFor', () => {
  it('lands exactly on the cron tick that closes the window, for two years of Fridays', () => {
    // The window a match belongs to is the one the digest closes, so this
    // helper must return an instant croner actually fires on — never a naive
    // +7×24h step, which drifts by an hour twice a year.
    const ticks = weeklyCronTicks(Date.UTC(2026, 0, 1), 104);
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

  it('handles both 2026 DST transitions, where the week is 167h or 169h long', () => {
    const [springPrev, springNext] = [Date.UTC(2026, 2, 27, 17), Date.UTC(2026, 3, 3, 16)];
    const [autumnPrev, autumnNext] = [Date.UTC(2026, 9, 23, 16), Date.UTC(2026, 9, 30, 17)];
    expect(springNext! - springPrev!).toBe(167 * 3600000);
    expect(autumnNext! - autumnPrev!).toBe(169 * 3600000);
    // The naive step would land an hour off in both directions.
    expect(springPrev! + 7 * 86400000).not.toBe(springNext);
    expect(digestWeekEndFor(springPrev! + 1)).toBe(springNext);
    expect(digestWeekEndFor(autumnPrev! + 1)).toBe(autumnNext);
  });

  it('files a Saturday match under the FOLLOWING Friday, not its own ISO week', () => {
    // This is the whole bug: the group plays weekends, and ISO Mon–Sun put that
    // play in the week that had already been published.
    const saturday = Date.UTC(2026, 7, 1, 18); // Sat 2026-08-01, 21:00 Kyiv
    expect(computeWeekIso(saturday)).toBe('2026-W31');
    expect(digestWeekIsoFor(saturday)).toBe('2026-W32');
  });

  it('names each window distinctly across two years', () => {
    const ticks = weeklyCronTicks(Date.UTC(2026, 0, 1), 104);
    const names = ticks.map((t) => digestWeekIsoFor(t - 1));
    expect(new Set(names).size).toBe(names.length);
  });
});
