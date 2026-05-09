import type { Context } from 'hono';

/**
 * POST /api/onboard — disabled during the Henrik -> Riot+RSO transition (issue #41).
 *
 * The previous Henrik trust-input flow is gone. Henrik returns code:24 for
 * console accounts, our community is console-only, so the endpoint never
 * worked for our users. The replacement RSO flow (issue #43) lands after
 * Riot Production approval (issue #40, App ID 834784, Pending Review).
 *
 * Until then this handler always returns 503 with `{ error: 'rso_pending' }`
 * and the Mini App's onboarding page renders a "Riot Sign-On is coming
 * soon" splash instead of the input form.
 *
 * Deps are kept in the signature so server wiring in src/server/index.ts
 * does not need to change for this transitional shim. The fields are
 * deliberately unused.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OnboardHandlerDeps = Record<string, any>;

export function makeOnboardHandler(_deps: OnboardHandlerDeps) {
  return (c: Context) => c.json({ error: 'rso_pending' }, 503);
}
