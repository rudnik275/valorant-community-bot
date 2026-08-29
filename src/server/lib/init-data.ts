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
  /**
   * Present only when the Mini App was opened via `sendChatJoinRequestWebApp`
   * (guard-bot flow, Bot API 10.1) — the capability token that lets the bot
   * resolve THIS join request through `answerChatJoinRequestQuery`.
   *
   * Read straight off the validated query string rather than through the
   * `parse()` helper: `validate()` verifies the HMAC over the WHOLE initData
   * string, so every parameter in it is authentic once validation passes. That
   * keeps us independent of whether the installed `@telegram-apps/init-data-node`
   * knows about this (new) field yet — it does not, and a library bump must not
   * be a prerequisite for the guard flow.
   */
  chat_join_request_query_id?: string;
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
    // Safe post-validation read — see the field's doc comment.
    const queryId = new URLSearchParams(initDataRaw).get('chat_join_request_query_id');
    if (queryId) {
      result.chat_join_request_query_id = queryId;
    }
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
