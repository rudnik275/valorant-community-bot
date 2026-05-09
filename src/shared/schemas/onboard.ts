import { z } from 'zod';

export const OnboardBodySchema = z.object({
  name: z.string().min(3).max(16),
  tag: z.string().min(3).max(5),
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
