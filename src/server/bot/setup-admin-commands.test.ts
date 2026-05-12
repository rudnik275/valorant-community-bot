import { describe, it, expect, vi } from 'vitest';
import { setupAdminCommandsForOwner, ADMIN_COMMANDS } from './setup-admin-commands.ts';
import { OWNER_TELEGRAM_ID } from './test-commands.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('setupAdminCommandsForOwner', () => {
  it('calls setMyCommands with scope=chat for OWNER_TELEGRAM_ID', async () => {
    const setMyCommands = vi.fn().mockResolvedValue(true);
    const bot = { api: { setMyCommands } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setupAdminCommandsForOwner(bot as any);

    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const [commands, opts] = setMyCommands.mock.calls[0]!;
    expect(commands).toEqual(ADMIN_COMMANDS);
    expect(opts).toEqual({ scope: { type: 'chat', chat_id: OWNER_TELEGRAM_ID } });
  });

  it('includes the three admin commands by name', () => {
    const names = ADMIN_COMMANDS.map((c) => c.command);
    expect(names).toContain('congrats');
    expect(names).toContain('test_digest');
    expect(names).toContain('test_runtime_events');
  });

  it('does not throw when Telegram API fails — failure is logged', async () => {
    const setMyCommands = vi.fn().mockRejectedValue(new Error('Telegram down'));
    const bot = { api: { setMyCommands } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(setupAdminCommandsForOwner(bot as any)).resolves.toBeUndefined();
  });
});
