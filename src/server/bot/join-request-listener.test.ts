/**
 * join-request-listener.test.ts — guard-bot handler.
 *
 * The contract under test is "every failure ends in do-nothing", because
 * do-nothing leaves the request pending for manual approval. A throw here would
 * escape into grammY's update loop.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'grammy';
import { makeJoinRequestListener, JOIN_REQUEST_WEBAPP_PARAMS } from './join-request-listener.ts';

vi.mock('../lib/log.ts', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ALLOWED_CHAT_ID = -1001;

function makeCtx(update: Record<string, unknown> | undefined): Context {
  return { update: { chat_join_request: update } } as unknown as Context;
}

function joinRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chat: { id: ALLOWED_CHAT_ID },
    from: { id: 555 },
    query_id: 'q-1',
    ...over,
  };
}

function makeDeps(over: Partial<Parameters<typeof makeJoinRequestListener>[0]> = {}) {
  return {
    isAllowedChat: (id: number) => id === ALLOWED_CHAT_ID,
    sendChatJoinRequestWebApp: vi.fn().mockResolvedValue(undefined),
    getMiniAppUrl: () => 'https://app.example',
    ...over,
  };
}

describe('makeJoinRequestListener', () => {
  it('shows the Mini App for a join request in an allowed chat', async () => {
    const deps = makeDeps();
    await makeJoinRequestListener(deps)(makeCtx(joinRequest()));

    expect(deps.sendChatJoinRequestWebApp).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(deps.sendChatJoinRequestWebApp).mock.calls[0]![0];
    // web_app_url is the one parameter name confirmed against the live API.
    expect(payload).toMatchObject({ web_app_url: 'https://app.example' });
  });

  it('ignores join requests for chats outside scope', async () => {
    const deps = makeDeps();
    await makeJoinRequestListener(deps)(makeCtx(joinRequest({ chat: { id: -999 } })));

    expect(deps.sendChatJoinRequestWebApp).not.toHaveBeenCalled();
  });

  it('leaves the request pending when there is no query_id', async () => {
    // No query_id ⇒ the bot is not this chat's guard bot. Nothing to answer;
    // the owner approves by hand, exactly as before the guard flow existed.
    const deps = makeDeps();
    const update = joinRequest();
    delete update['query_id'];

    await makeJoinRequestListener(deps)(makeCtx(update));

    expect(deps.sendChatJoinRequestWebApp).not.toHaveBeenCalled();
  });

  it('leaves the request pending when the Mini App URL is not configured', async () => {
    const deps = makeDeps({ getMiniAppUrl: () => '' });
    await makeJoinRequestListener(deps)(makeCtx(joinRequest()));

    expect(deps.sendChatJoinRequestWebApp).not.toHaveBeenCalled();
  });

  it('swallows an API failure instead of throwing into the update loop', async () => {
    const deps = makeDeps({
      sendChatJoinRequestWebApp: vi.fn().mockRejectedValue(new Error('Bad Request: unknown field')),
    });

    await expect(
      makeJoinRequestListener(deps)(makeCtx(joinRequest())),
    ).resolves.toBeUndefined();
  });

  it('ignores updates that are not join requests', async () => {
    const deps = makeDeps();
    await makeJoinRequestListener(deps)(makeCtx(undefined));

    expect(deps.sendChatJoinRequestWebApp).not.toHaveBeenCalled();
  });
});

describe('JOIN_REQUEST_WEBAPP_PARAMS', () => {
  it('sends the URL as a flat web_app_url, not a nested web_app object', async () => {
    // Probed 2026-08-29: an empty call answers `parameter "web_app_url" is
    // required`. A nested { web_app: { url } } does NOT satisfy it.
    const params = JOIN_REQUEST_WEBAPP_PARAMS('q-1', 'https://app.example');

    expect(params['web_app_url']).toBe('https://app.example');
    expect(params['web_app']).toBeUndefined();
  });

  it('carries the query id under both candidate names', () => {
    // The id parameter name is still unconfirmed and unknown fields are ignored
    // by the Bot API, so over-sending is free while guessing wrong is not.
    const params = JOIN_REQUEST_WEBAPP_PARAMS('q-42', 'https://app.example');

    expect(params['chat_join_request_query_id']).toBe('q-42');
    expect(params['query_id']).toBe('q-42');
  });
});
