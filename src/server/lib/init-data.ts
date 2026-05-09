import { validate, parse } from '@telegram-apps/init-data-node';

export class InvalidInitDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInitDataError';
  }
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
  last_name?: string;
}

/**
 * Validates initData raw string from Telegram Mini App and returns the user.
 * Throws InvalidInitDataError on invalid HMAC or expired auth_date (>24h).
 */
export function verifyInitData(initDataRaw: string, botToken: string): TelegramUser {
  try {
    validate(initDataRaw, botToken, { expiresIn: 86400 });
    const parsed = parse(initDataRaw);
    if (!parsed.user) {
      throw new InvalidInitDataError('No user in initData');
    }
    const user = parsed.user;
    const result: TelegramUser = {
      id: user.id,
      first_name: user.first_name,
    };
    if (user.username !== undefined) {
      result.username = user.username;
    }
    if (user.last_name !== undefined) {
      result.last_name = user.last_name;
    }
    return result;
  } catch (err) {
    if (err instanceof InvalidInitDataError) {
      throw err;
    }
    throw new InvalidInitDataError((err as Error).message);
  }
}
