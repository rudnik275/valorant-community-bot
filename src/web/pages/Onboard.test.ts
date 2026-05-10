// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import Onboard from './Onboard.vue';
import MembersList from './MembersList.vue';

// Mock global fetch for all tests
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'members', component: MembersList },
      { path: '/onboard', name: 'onboard', component: Onboard },
    ],
  });
}

function mountOnboard() {
  return mount(Onboard, { global: { plugins: [makeRouter()] } });
}

function makeOkResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeErrorResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

describe('Onboard.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // no global cleanup needed
  });

  // ── Form rendering ───────────────────────────────────────────────────────────

  it('renders name and tag inputs and a submit button', () => {
    const wrapper = mountOnboard();

    expect(wrapper.find('[data-testid="input-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="input-tag"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="submit-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="submit-btn"]').text()).toContain('Привязать аккаунт');
  });

  it('renders a "#" visual separator between the two inputs', () => {
    const wrapper = mountOnboard();
    expect(wrapper.text()).toContain('#');
  });

  it('does not show success message initially', () => {
    const wrapper = mountOnboard();
    expect(wrapper.find('[data-testid="success-message"]').exists()).toBe(false);
  });

  // ── Client-side validation ───────────────────────────────────────────────────

  it('shows a validation error when name is empty on submit', async () => {
    const wrapper = mountOnboard();

    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="validation-error"]').exists()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a validation error when tag is empty on submit', async () => {
    const wrapper = mountOnboard();

    await wrapper.find('[data-testid="input-name"]').setValue('PlayerName');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="validation-error"]').exists()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a validation error when tag contains non-alphanumeric chars', async () => {
    const wrapper = mountOnboard();

    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU#1');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="validation-error"]').exists()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('shows success message after a successful API call', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'TestPlayer',
      riot_tag: 'EU1',
      riot_region: 'eu',
    }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('TestPlayer');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="success-message"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="success-message"]').text()).toContain('TestPlayer#EU1');
    expect(wrapper.find('[data-testid="success-message"]').text()).toContain('eu');
  });

  it('POSTs to /api/onboard with { name, tag }', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'TestPlayer',
      riot_tag: 'EU1',
      riot_region: 'eu',
    }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('TestPlayer');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboard');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ name: 'TestPlayer', tag: 'EU1' });
  });

  // ── Loading state ────────────────────────────────────────────────────────────

  it('disables the submit button while loading', async () => {
    // Never resolves during the test — simulates in-flight request
    fetchMock.mockReturnValue(new Promise(() => {}));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    const btn = wrapper.find('[data-testid="submit-btn"]').element as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── Error states ─────────────────────────────────────────────────────────────

  it('shows actionable "сыграй один матч" message for account_inactive', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(404, {
      error: 'account_inactive',
      message: 'Аккаунт найден, но Riot не показывает по нему свежих матчей. Сыграй один матч (можно Deathmatch) и попробуй снова — после игры всё подтянется.',
    }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('YarosBzdun');
    await wrapper.find('[data-testid="input-tag"]').setValue('2307');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Сыграй один матч');
  });

  it('shows "Аккаунт Riot не найден" for account_not_found', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(404, { error: 'account_not_found' }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Ghost');
    await wrapper.find('[data-testid="input-tag"]').setValue('X1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Аккаунт Riot не найден');
  });

  it('shows rate limit message for rate_limited', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(429, { error: 'rate_limited', retry_after: 60 }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Слишком много запросов');
  });

  it('shows already-linked message for puuid_already_linked', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(409, { error: 'puuid_already_linked' }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('уже привязан');
  });

  it('shows upstream message for henrik_upstream', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(502, { error: 'henrik_upstream' }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Henrik');
  });

  it('shows generic fallback message for unknown error codes', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500, { error: 'internal_error' }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Что-то пошло не так');
  });

  it('shows generic message when fetch throws (network error)', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1');
    await wrapper.find('form').trigger('submit');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="api-error"]').text()).toContain('Что-то пошло не так');
  });
});
