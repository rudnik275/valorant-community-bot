// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import Onboard from './Onboard.vue';
import MembersList from './MembersList.vue';

// We mock global fetch to control API responses
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.resetAllMocks();
});

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'members', component: MembersList },
      { path: '/onboard', name: 'onboard', component: Onboard },
    ],
  });
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Onboard.vue', () => {
  it('shows the form initially', async () => {
    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    expect(wrapper.find('input').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.find('button').text()).toContain('Привязать');
  });

  it('shows loading state while request is in progress', async () => {
    // Never resolves
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('TestPlayer#EU1');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.find('button').text()).toContain('Загрузка');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });

  it('shows error message on 404 (riot_id_not_found)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse(404, { error: 'riot_id_not_found' }));

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('bad#42');
    await wrapper.find('form').trigger('submit');

    // Wait for async to settle
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('Riot ID не найден');
  });

  it('shows error message on 503 (henrik_rate_limited) with retryAfter', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(503, { error: 'henrik_rate_limited', retryAfter: 30 }),
    );

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('TestPlayer#EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('Henrik API перегружен');
    expect(error.text()).toContain('30');
  });

  it('shows error message on 409 (puuid_already_linked) with username', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(409, { error: 'puuid_already_linked', other: '@otherusername' }),
    );

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('TestPlayer#EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('@otherusername');
    expect(error.text()).toContain('привязан');
  });

  it('shows error message on bot_lacks_admin_rights', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(500, { error: 'bot_lacks_admin_rights', chatId: -100123 }),
    );

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('TestPlayer#EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('admin-права');
  });

  it('shows success message on successful onboarding', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse(200, {
        success: true,
        profile: { name: 'TestPlayer', tag: 'EU1', puuid: 'puuid-abc' },
        joinedGroup: true,
      }),
    );

    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('TestPlayer#EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const success = wrapper.find('[data-testid="success"]');
    expect(success.exists()).toBe(true);
    expect(success.text()).toContain('Готово');
  });

  it('shows validation error when no # in input', async () => {
    const wrapper = mount(Onboard, {
      global: { plugins: [makeRouter()] },
    });

    await wrapper.find('input').setValue('NoHashSign');
    await wrapper.find('form').trigger('submit');

    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain('Имя#TAG');
    // fetch should NOT have been called
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
