// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import Settings from './Settings.vue';
import MembersList from './MembersList.vue';

// Mock the api module
vi.mock('../lib/api.ts', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../lib/api.ts';

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'members', component: MembersList },
      { path: '/settings', name: 'settings', component: Settings },
    ],
  });
}

const linkedMeResponse = {
  onboarded: true,
  profile: {
    telegramId: 123456,
    riotName: 'Player',
    riotTag: 'EUW',
    riotPuuid: 'some-puuid',
    currentRank: { tierId: 17, tierName: 'Platinum 3' },
    peakRank: { tierId: 21, tierName: 'Ascendant 1', seasonShort: 'e11a2' },
    region: 'eu',
  },
};

const linkedMeResponseNoRank = {
  onboarded: true,
  profile: {
    telegramId: 123456,
    riotName: 'Player',
    riotTag: 'EUW',
    riotPuuid: 'some-puuid',
    currentRank: null,
    peakRank: null,
    region: null,
  },
};

const unlinkedMeResponse = {
  onboarded: false,
  profile: null,
};

describe('Settings.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock Telegram WebApp
    (window as Window & { Telegram?: unknown }).Telegram = {
      WebApp: {
        BackButton: {
          show: vi.fn(),
          hide: vi.fn(),
          onClick: vi.fn(),
          offClick: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    delete (window as Window & { Telegram?: unknown }).Telegram;
  });

  it('renders the "Настройки" heading', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Настройки');
  });

  it('renders linked-account card when /api/me returns linked user', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="linked-account"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="not-linked"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Привязанный аккаунт');
  });

  it('renders riot name#tag when user is linked', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const nameTag = wrapper.find('[data-testid="riot-name-tag"]');
    expect(nameTag.exists()).toBe(true);
    expect(nameTag.text()).toContain('Player#EUW');
  });

  it('renders "not linked" CTA when /api/me returns no linkage', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(unlinkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="not-linked"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="linked-account"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Аккаунт не привязан');
    expect(wrapper.text()).toContain('Открыть онбординг');
  });

  it('shows "Аккаунт не привязан" when onboarded is false', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(unlinkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Аккаунт не привязан');
  });

  it('shows BackButton on mount and hides on unmount', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const twa = (window as Window & { Telegram?: { WebApp?: { BackButton?: { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; onClick: ReturnType<typeof vi.fn>; offClick: ReturnType<typeof vi.fn> } } } }).Telegram?.WebApp?.BackButton;

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(twa?.show).toHaveBeenCalled();

    wrapper.unmount();
    expect(twa?.hide).toHaveBeenCalled();
  });

  it('does not render a toggle checkbox (opt-out removed)', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });

  it('shows rank pills and region when rank fields are set', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponse);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="current-rank"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="current-rank"]').text()).toContain('Platinum 3');
    expect(wrapper.find('[data-testid="region-label"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="region-label"]').text()).toContain('Регион: EU');
  });

  it('does not show rank-row or region-label when rank fields are null', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(linkedMeResponseNoRank);

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="rank-row"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="region-label"]').exists()).toBe(false);
  });
});
