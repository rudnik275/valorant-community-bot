import { z } from 'zod';

/**
 * Riot IDs are Unicode. Cyrillic, CJK and accented-Latin taglines all exist in
 * the wild (`Любовница Омена#тётя` is a real member of this group), so the tag
 * rule validates against Unicode letter/number classes — never `[a-zA-Z0-9]`.
 *
 * `\p{M}` is in the class on purpose: mobile keyboards emit *decomposed* text,
 * where `ё` is `е` + U+0308 — a combining mark, not a letter. Such input is
 * normalized to NFC below, but the class stays permissive so a mark that
 * survives normalization can never hard-block a real player.
 */
const TAG_RE = /^[\p{L}\p{N}\p{M}]+$/u;

/**
 * Sanitize free-text Riot ID input at the schema boundary, so client and server
 * agree byte-for-byte on what reaches Henrik (the drift #257 was about).
 *
 * - NFC: decomposed input is visually identical but never matches what Riot
 *   stored, and inflates `.length` (`тётя` is 5 code units decomposed, 4 in NFC).
 * - Exotic spaces / zero-widths: copy-pasting a Riot ID out of the client or a
 *   chat drags in NBSP and friends, which are invisible and silently fail the
 *   account lookup.
 */
const sanitize = (s: string) =>
  s
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\p{Zs}/gu, ' ')
    .trim();

/** Sanitize first, then measure — length limits apply to the normalized value. */
const riotText = (max: number) =>
  z.string().transform(sanitize).pipe(z.string().min(1).max(max));

export const OnboardBodySchema = z.object({
  name: riotText(16),
  tag: riotText(5).pipe(z.string().regex(TAG_RE)),
});

export const OnboardResponseSchema = z.object({
  success: z.literal(true),
  profile: z.object({
    name: z.string(),
    tag: z.string(),
    puuid: z.string(),
  }),
  joinedGroup: z.boolean(),
});

export const OnboardErrorSchema = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
  other: z.string().optional(),
});
