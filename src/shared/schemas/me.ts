import { z } from 'zod';

export const MeResponseSchema = z.object({
  onboarded: z.boolean(),
  profile: z
    .object({
      telegramId: z.number(),
      riotName: z.string().nullable(),
      riotTag: z.string().nullable(),
      riotPuuid: z.string().nullable(),
    })
    .nullable(),
});
