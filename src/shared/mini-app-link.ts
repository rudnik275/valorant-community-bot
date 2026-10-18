/**
 * The link that opens the Mini App INSIDE Telegram.
 *
 * A bare `https://bot.<domain>` link in a message opens in the phone's default
 * browser, where there is no Telegram initData — every API call then answers
 * 401 and the newcomer sees "API /api/members failed: 401" (2026-10-18).
 * A t.me Direct Link opens Telegram's own WebView instead. `open` is the short
 * name of the Direct Link configured in @BotFather (Bot Settings → Mini Apps →
 * Direct Links), pointing at PUBLIC_BASE_URL.
 *
 * `web_app_url` / `web_app` button fields still take the https URL — this link
 * is for plain text links and url-buttons only.
 */
export const BOT_USERNAME = 'valorant_comunity_bot';
export const MINI_APP_LINK = `https://t.me/${BOT_USERNAME}/open`;
