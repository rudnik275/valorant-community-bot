import { describe, expect, it, vi } from 'vitest';
import { sendDailyDigest } from './send.ts';

const row = (i: number) => `- <tg-emoji emoji-id="123">💎</tg-emoji> <b>SixteenLetterNam#TAG</b> <a href="https://tracker.gg/valorant/match/${i}"><tg-emoji emoji-id="456">🦸</tg-emoji>/<tg-emoji emoji-id="789">🗺️</tg-emoji></a>`;

describe('sendDailyDigest', () => {
  it('sends a short digest byte-identically in one message and returns its result', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 7 });
    const text = `🍿 Эйсы и ножи за предыдущие 24 часа\n\n🎯 Эйсы\n${row(1)}`;
    expect(await sendDailyDigest(text, send)).toEqual({ message_id: 7 });
    expect(send.mock.calls).toEqual([[text]]);
  });

  it('splits 150 rows into sequential messages by parsed UTF-16 length, keeping every row and link intact', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(i));
    const text = ['🍿 Эйсы и ножи за предыдущие 24 часа', '', '🎯 Эйсы', ...rows].join('\n');
    const sent: string[] = [];
    let active = false;
    const send = async (chunk: string) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      sent.push(chunk);
      active = false;
      return { message_id: sent.length };
    };
    const result = await sendDailyDigest(text, send);
    expect(sent).toHaveLength(2);
    expect(result).toEqual({ message_id: 2 });
    expect(sent.join('\n')).toBe(text);
    expect(sent.flatMap((chunk) => chunk.split('\n')).filter((line) => line.startsWith('- '))).toEqual(rows);
    for (const chunk of sent) expect(chunk.replace(/<[^>]*>/g, '').length).toBeLessThanOrEqual(4096);
  });

  it('counts escaped entities once and accepts exactly 4096 visible UTF-16 units', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 1 });
    const text = `<b>${'&amp;&lt;&gt;&quot;&#39;'.repeat(819)}x</b>`;
    await sendDailyDigest(text, send);
    expect(send.mock.calls).toEqual([[text]]);
  });

  it('counts astral emoji as two UTF-16 units and keeps escaped tags as visible text', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 1 });
    const text = `${'&lt;b&gt;'.repeat(1364)}💎💎\nx`;
    await sendDailyDigest(text, send);
    expect(send.mock.calls).toEqual([[text.split('\n')[0]], ['x']]);
  });

  it('rejects an oversized complete row before sending any earlier chunks', async () => {
    const send = vi.fn().mockResolvedValue({ message_id: 1 });
    await expect(sendDailyDigest(`${'x'.repeat(4096)}\n<b>${'y'.repeat(4097)}</b>`, send)).rejects.toThrow('Daily digest line exceeds Telegram message limit');
    expect(send).not.toHaveBeenCalled();
  });

  it('stops immediately after a rejected send without retrying or sending later chunks', async () => {
    const failure = new Error('Telegram unavailable');
    const send = vi.fn().mockResolvedValueOnce({ message_id: 1 }).mockRejectedValueOnce(failure);
    const text = Array.from({ length: 450 }, (_, i) => row(i)).join('\n');
    await expect(sendDailyDigest(text, send)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
