/**
 * ephemeral-message.test.ts — the fallback chain is the whole point of this
 * module, so that is what these tests pin down. Ephemeral delivery itself is
 * a live-API behaviour and is deliberately not simulated here.
 */

import { describe, it, expect, vi } from 'vitest';
import { notifyUserQuietly } from './ephemeral-message.ts';

vi.mock('./log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ARGS = { chatId: -100, userId: 7, html: 'hi', reason: 'test' };

describe('notifyUserQuietly', () => {
  it('prefers ephemeral and never falls back when it succeeds', async () => {
    const sendEphemeral = vi.fn().mockResolvedValue({ message_id: 1 });
    const sendDirect = vi.fn().mockResolvedValue({ message_id: 2 });

    const outcome = await notifyUserQuietly({ sendEphemeral, sendDirect }, ARGS);

    expect(outcome).toBe('ephemeral');
    expect(sendEphemeral).toHaveBeenCalledWith(-100, 7, 'hi');
    // The DM is what 29 other people would NOT see either — but it costs the
    // user a notification they didn't need. Must not fire on the happy path.
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it('falls back to a DM when ephemeral fails', async () => {
    const sendEphemeral = vi.fn().mockRejectedValue(new Error('unknown field'));
    const sendDirect = vi.fn().mockResolvedValue({ message_id: 2 });

    const outcome = await notifyUserQuietly({ sendEphemeral, sendDirect }, ARGS);

    expect(outcome).toBe('dm');
    expect(sendDirect).toHaveBeenCalledWith(7, 'hi');
  });

  it('gives up quietly when both paths fail — never throws', async () => {
    // Most group members have never opened a private chat with the bot, so a
    // failing DM is the normal case, not an exceptional one. A notification
    // failing must never abort the caller's real work.
    const sendEphemeral = vi.fn().mockRejectedValue(new Error('nope'));
    const sendDirect = vi.fn().mockRejectedValue(new Error('bot was blocked'));

    await expect(
      notifyUserQuietly({ sendEphemeral, sendDirect }, ARGS),
    ).resolves.toBe('skipped');
  });
});
