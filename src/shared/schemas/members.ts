import { z } from 'zod';

export const MemberSchema = z.object({
  telegramId: z.number(),
  telegramUsername: z.string().nullable(),
  telegramAvatarUrl: z.string().url().nullable(),
  riotName: z.string().nullable(),
  riotTag: z.string().nullable(),
  currentTierId: z.number().nullable(),
  currentTierName: z.string().nullable(),
  peakTierId: z.number().nullable(),
  peakTierName: z.string().nullable(),
  peakSeasonShort: z.string().nullable(),
  lastMatch: z.object({
    startedAt: z.string().datetime(),
    result: z.enum(['win', 'loss', 'draw']),
    agent: z.string(),
  }).nullable(),
  kdRatioLast10: z.number().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
});

export const MembersResponseSchema = z.array(MemberSchema);

export type Member = z.infer<typeof MemberSchema>;
