import { z } from 'zod';

export const MeResponseSchema = z.object({
  onboarded: z.boolean(),
  profile: z
    .object({
      telegramId: z.number(),
      riotName: z.string().nullable(),
      riotTag: z.string().nullable(),
      riotPuuid: z.string().nullable(),
      currentRank: z.object({
        tierId: z.number(),
        tierName: z.string(),
      }).nullable(),
      peakRank: z.object({
        tierId: z.number(),
        tierName: z.string(),
        seasonShort: z.string().nullable(),
      }).nullable(),
      region: z.string().nullable(),
    })
    .nullable(),
});
