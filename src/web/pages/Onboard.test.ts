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

  it('submits a Cyrillic Riot ID instead of rejecting it', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'Любовница Омена',
      riot_tag: 'тётя',
      riot_region: 'eu',
    }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Любовница Омена');
    await wrapper.find('[data-testid="input-tag"]').setValue('тётя');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="validation-error"]').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      name: 'Любовница Омена',
      tag: 'тётя',
    });
  });

  it('sends decomposed keyboard input to the API in NFC form', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'Player',
      riot_tag: 'тётя',
      riot_region: 'eu',
    }));

    const wrapper = mountOnboard();
    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('тётя'.normalize('NFD'));
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).tag).toBe('тётя');
  });

  it('reports the tag length limit separately from the format rule', async () => {
    const wrapper = mountOnboard();

    await wrapper.find('[data-testid="input-name"]').setValue('Player');
    await wrapper.find('[data-testid="input-tag"]').setValue('EU1234');
    await wrapper.find('form').trigger('submit');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="validation-error"]').text()).toContain('не больше 5');
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

  /** Submit the form and let the fetch microtask settle. */
  async function submitOnboard(wrapper: ReturnType<typeof mount>) {
    await wrapper.find('[data-testid="input-name"]').setValue('YarosBzdun');
    await wrapper.find('[data-testid="input-tag"]').setValue('2307');
    await wrapper.find('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
  }

  // A pending nick used to bounce silently to the members list. It must now
  // explain itself: since onboard admits on Henrik-side failures, «pending» can
  // mean «nobody checked this nick», and a later re-gate would otherwise look
  // like the bot randomly muting the user.
  it('explains an inactive-account pending instead of silently redirecting', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'YarosBzdun',
      riot_tag: '2307',
      riot_puuid: null,
      riot_region: null,
      pending: true,
      pending_reason: 'inactive',
    }));

    const router = makeRouter();
    const wrapper = mount(Onboard, { global: { plugins: [router] } });
    await router.push('/onboard');
    await submitOnboard(wrapper);

    expect(wrapper.find('[data-testid="success-message"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pending-inactive"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="pending-unreachable"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="api-error"]').exists()).toBe(false);
  });

  it('warns that an unverified nick may be re-checked later', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'YarosBzdun',
      riot_tag: '2307',
      riot_puuid: null,
      riot_region: null,
      pending: true,
      pending_reason: 'henrik_unreachable',
    }));

    const router = makeRouter();
    const wrapper = mount(Onboard, { global: { plugins: [router] } });
    await router.push('/onboard');
    await submitOnboard(wrapper);

    const text = wrapper.find('[data-testid="pending-unreachable"]').text();
    expect(text).toContain('не вышло');
    expect(wrapper.find('[data-testid="pending-inactive"]').exists()).toBe(false);
  });

  it('offers a way onward to the members list on the pending path', async () => {
    // Outside the join flow the user IS in the group, so the terminal card must
    // not be a dead end — the old redirect at least got them somewhere.
    fetchMock.mockResolvedValue(makeOkResponse({
      status: 'ok',
      riot_name: 'YarosBzdun',
      riot_tag: '2307',
      riot_puuid: null,
      riot_region: null,
      pending: true,
      pending_reason: 'inactive',
    }));

    const router = makeRouter();
    const wrapper = mount(Onboard, { global: { plugins: [router] } });
    await router.push('/onboard');
    await submitOnboard(wrapper);

    await wrapper.find('[data-testid="continue-btn"]').trigger('click');
    // router.push resolves asynchronously — a tick alone lands before navigation.
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(router.currentRoute.value.name).toBe('members');
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
