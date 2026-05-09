/**
 * telegram-avatar.ts — Lazy avatar cache with 24-hour TTL.
 *
 * Avatars are fetched only when the Mini App requests /api/members, not on
 * every group message. This avoids hitting Telegram's rate limits per-message.
 *
 * Note: getUserProfilePhotos requires that the bot has previously interacted
 * with the user (e.g., user is in a group the bot monitors). Users who have
 * written in the group are already registered via the listener, so by the time
 * the Mini App is opened, the interaction requirement is satisfied.
 */

import { eq } from 'drizzle-orm';
import logger from './log.ts';
import { users } from '../db/schema/users.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

interface TelegramApi {
  getUserProfilePhotos(userId: number, opts: { limit: number }): Promise<{
    total_count: number;
    photos: Array<Array<{ file_id: string; width: number; height: number }>>;
  }>;
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface AvatarCacheDeps {
  db: AnyDb;
  getApi: () => TelegramApi;
  getBotToken: () => string;
}

export interface AvatarResult {
  url: string | null;
  fileId: string | null;
}

export class UserNotFoundError extends Error {
  constructor(telegramUserId: number) {
    super(`User ${telegramUserId} not found in DB — cannot fetch avatar`);
    this.name = 'UserNotFoundError';
  }
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Factory: returns an object with `ensureAvatar(userId)` that lazily fetches
 * and caches the user's Telegram profile photo URL.
 *
 * In production, pass the real db, `() => bot.api`, and `() => process.env.TELEGRAM_BOT_TOKEN`.
 * In tests, inject in-memory db and `vi.fn()` API mocks.
 */
export function makeAvatarCache(deps: AvatarCacheDeps) {
  return {
    async ensureAvatar(telegramUserId: number): Promise<AvatarResult> {
      // Fetch the current row
      const rows = await deps.db
        .select({
          telegram_avatar_url: users.telegram_avatar_url,
          telegram_avatar_file_id: users.telegram_avatar_file_id,
          telegram_avatar_fetched_at: users.telegram_avatar_fetched_at,
        })
        .from(users)
        .where(eq(users.telegram_id, telegramUserId));

      if (!rows || rows.length === 0) {
        throw new UserNotFoundError(telegramUserId);
      }

      const row = rows[0] as {
        telegram_avatar_url: string | null;
        telegram_avatar_file_id: string | null;
        telegram_avatar_fetched_at: number | null;
      };

      const now = Date.now();
      const fetchedAt = row.telegram_avatar_fetched_at;

      // Return cached value if still fresh
      if (fetchedAt !== null && now - fetchedAt < CACHE_TTL_MS) {
        logger.debug(
          { event: 'avatar_cache_hit', user_id: telegramUserId },
          'Returning cached avatar',
        );
        return { url: row.telegram_avatar_url, fileId: row.telegram_avatar_file_id };
      }

      // Cache miss — call the Telegram API
      logger.debug(
        { event: 'avatar_api_hit', user_id: telegramUserId },
        'Fetching avatar from Telegram API',
      );

      const api = deps.getApi();
      const photosResult = await api.getUserProfilePhotos(telegramUserId, { limit: 1 });

      if (photosResult.total_count === 0 || !photosResult.photos[0]?.length) {
        // No profile photo — cache the "no photo" result so we don't re-hit the API constantly
        logger.debug(
          { event: 'avatar_no_photo', user_id: telegramUserId },
          'User has no profile photo — caching null',
        );
        await deps.db
          .update(users)
          .set({
            telegram_avatar_file_id: null,
            telegram_avatar_url: null,
            telegram_avatar_fetched_at: now,
          })
          .where(eq(users.telegram_id, telegramUserId));

        return { url: null, fileId: null };
      }

      // Take the smallest size of the first photo (first element in the inner array)
      const photo = photosResult.photos[0][0];
      if (!photo) {
        return { url: null, fileId: null };
      }

      const fileInfo = await api.getFile(photo.file_id);
      if (!fileInfo.file_path) {
        logger.debug(
          { event: 'avatar_no_file_path', user_id: telegramUserId },
          'getFile returned no file_path',
        );
        return { url: null, fileId: photo.file_id };
      }

      const botToken = deps.getBotToken();
      const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;

      await deps.db
        .update(users)
        .set({
          telegram_avatar_file_id: photo.file_id,
          telegram_avatar_url: url,
          telegram_avatar_fetched_at: now,
        })
        .where(eq(users.telegram_id, telegramUserId));

      logger.debug(
        { event: 'avatar_cached', user_id: telegramUserId },
        'Avatar URL fetched and cached',
      );

      return { url, fileId: photo.file_id };
    },
  };
}
