// One-off announcement to the group chat, run inside the prod container by
// `.github/workflows/announce.yml`. The bot token and chat id come from the
// container's own env, so the token never leaves the server.
//
// ANNOUNCE_B64 — the message (Telegram HTML), base64-encoded so quotes and
//                newlines survive the SSH hop untouched.
// SILENT=1     — post without a notification sound.
//
// Prints only the posted message id. Never print the request URL or a raw
// fetch error: the URL carries the bot token.

const token = process.env['TELEGRAM_BOT_TOKEN'];
const chatId = process.env['TELEGRAM_PRIMARY_CHAT_ID'];
const b64 = process.env['ANNOUNCE_B64'];

if (!token || !chatId || !b64) {
  console.error('announce: TELEGRAM_BOT_TOKEN, TELEGRAM_PRIMARY_CHAT_ID and ANNOUNCE_B64 are all required');
  process.exit(1);
}

const text = Buffer.from(b64, 'base64').toString('utf8');
if (text.trim() === '') {
  console.error('announce: ANNOUNCE_B64 decodes to an empty message');
  process.exit(1);
}

let body: { ok: boolean; result?: { message_id: number }; error_code?: number; description?: string };
try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: Number(chatId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: process.env['SILENT'] === '1',
    }),
  });
  body = await res.json();
} catch (err) {
  console.error(`announce: request to Telegram failed (${(err as Error).name})`);
  process.exit(1);
}

if (!body.ok || !body.result) {
  console.error(`announce: Telegram refused — ${body.error_code} ${body.description}`);
  process.exit(1);
}
console.log(`announce: posted message_id=${body.result.message_id}`);
