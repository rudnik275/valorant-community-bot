import { z } from 'zod';

export const SettingsSchema = z.object({ chatRealtimeDisabled: z.boolean() });
export type Settings = z.infer<typeof SettingsSchema>;
