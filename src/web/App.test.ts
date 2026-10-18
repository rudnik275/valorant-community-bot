// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { MINI_APP_LINK } from '../shared/mini-app-link.ts';

vi.mock('./lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api.ts')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from './lib/api.ts';

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'members', component: { template: '<div data-testid="members-page" />' } },
      { path: '/onboard', name: 'onboard', component: { template: '<div />' } },
    ],
  });
}

function setInitData(initData: string | undefined) {
  (window as unknown as { Telegram?: unknown }).Telegram =
    initData === undefined ? undefined : { WebApp: { initData } };
}

async function mountApp() {
  const router = makeRouter();
  await router.push('/');
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe('App', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => setInitData(undefined));

  it('opened in a plain browser: points back into Telegram instead of calling the API', async () => {
    // telegram-web-app.js is loaded outside Telegram too — WebApp exists, initData is empty.
    setInitData('');
    const wrapper = await mountApp();

    const link = wrapper.get('[data-testid="open-in-telegram"]');
    expect(link.attributes('href')).toBe(MINI_APP_LINK);
    expect(wrapper.find('[data-testid="members-page"]').exists()).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('inside Telegram: renders the app', async () => {
    setInitData('query_id=1&user=%7B%7D&hash=abc');
    vi.mocked(apiFetch).mockResolvedValue({ onboarded: true });
    const wrapper = await mountApp();

    expect(wrapper.find('[data-testid="members-page"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="open-in-telegram"]').exists()).toBe(false);
  });
});
