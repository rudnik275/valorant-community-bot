const MAX_MESSAGE_LENGTH = 4096;

/** Count visible UTF-16 units; decode after removing tags so escaped nick text stays text. */
function parsedLength(html: string): number {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  };
  return html
    .replace(/<\/?(?:b|a|tg-emoji)(?:\s[^>]*)?>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]!)
    .length;
}

/** All tags emitted by the daily renderer close on the same line. Never split inside a row. */
function splitDailyDigest(text: string): string[] {
  const chunks: string[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const line of text.split('\n')) {
    const lineLength = parsedLength(line);
    if (lineLength > MAX_MESSAGE_LENGTH) throw new Error('Daily digest line exceeds Telegram message limit');
    if (lines.length && length + 1 + lineLength > MAX_MESSAGE_LENGTH) {
      chunks.push(lines.join('\n'));
      lines = [];
      length = 0;
    }
    length += (lines.length ? 1 : 0) + lineLength;
    lines.push(line);
  }
  chunks.push(lines.join('\n'));
  return chunks;
}

/** Validate every chunk before delivery; return the final result only after every send succeeds. */
export async function sendDailyDigest(
  text: string,
  send: (chunk: string) => Promise<{ message_id: number }>,
): Promise<{ message_id: number }> {
  const chunks = splitDailyDigest(text);
  let result = await send(chunks[0]!);
  for (const chunk of chunks.slice(1)) result = await send(chunk);
  return result;
}
