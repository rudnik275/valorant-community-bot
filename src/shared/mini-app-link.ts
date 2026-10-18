/**
 * The link that opens the Mini App INSIDE Telegram.
 *
 * A bare `https://bot.<domain>` link in a message opens in the phone's default
 * browser, where there is no Telegram initData — every API call then answers
 * 401 and the newcomer sees "API /api/members failed: 401" (2026-10-18).
 * `t.me/<bot>?startapp` opens the bot's Main Mini App in Telegram's own WebView
 * instead. Requires "Main Mini App" enabled in @BotFather (Bot Settings →
 * Configure Mini App), pointing at PUBLIC_BASE_URL.
 *
 * `web_app_url` / `web_app` button fields still take the https URL — this link
 * is for plain text links and url-buttons only.
 */
export const BOT_USERNAME = 'valorant_comunity_bot';
export const MINI_APP_LINK = `https://t.me/${BOT_USERNAME}?startapp`;
