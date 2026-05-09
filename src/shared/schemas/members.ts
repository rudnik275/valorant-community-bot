import { z } from 'zod';

export const MemberSchema = z.object({
  telegramId: z.number(),
  telegramUsername: z.string().nullable(),
  telegramAvatarUrl: z.string().url().nullable(),
  riotName: z.string().nullable(),
  riotTag: z.string().nullable(),
  currentRank: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
});

export const MembersResponseSchema = z.array(MemberSchema);

export type Member = z.infer<typeof MemberSchema>;
