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
        HapticFeedback: {
          impactOccurred: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    delete (window as Window & { Telegram?: unknown }).Telegram;
  });

  it('renders with switch unchecked when API returns chatRealtimeDisabled: false', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ chatRealtimeDisabled: false });

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const checkbox = wrapper.find('input[type="checkbox"]');
    expect(checkbox.exists()).toBe(true);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  it('renders with switch checked when API returns chatRealtimeDisabled: true', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ chatRealtimeDisabled: true });

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const checkbox = wrapper.find('input[type="checkbox"]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  it('calls PATCH with chatRealtimeDisabled: true when switch is clicked (unchecked → checked)', async () => {
    // First call is GET, second is PATCH
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ chatRealtimeDisabled: false })
      .mockResolvedValueOnce({ chatRealtimeDisabled: true });

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const checkbox = wrapper.find('input[type="checkbox"]');
    // In jsdom, trigger('change') does not automatically toggle checked.
    // We must set the checked property before triggering the event.
    (checkbox.element as HTMLInputElement).checked = true;
    await checkbox.trigger('change');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // Verify PATCH was called with correct args
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const [, , patchOpts] = (apiFetch as ReturnType<typeof vi.fn>).mock.calls[1] as [string, unknown, RequestInit];
    expect(patchOpts.method).toBe('PATCH');
    expect(JSON.parse(patchOpts.body as string)).toEqual({ chatRealtimeDisabled: true });
  });

  it('reverts switch and shows error when PATCH throws', async () => {
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ chatRealtimeDisabled: false })
      .mockRejectedValueOnce(new Error('API /api/me/settings failed: 500'));

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const checkbox = wrapper.find('input[type="checkbox"]');
    await checkbox.trigger('change');

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // Switch should have reverted to unchecked
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);

    // Error message should be shown
    const errorEl = wrapper.find('[data-testid="settings-error"]');
    expect(errorEl.exists()).toBe(true);
    expect(errorEl.text()).toContain('Ошибка');
  });

  it('shows the explanatory hint text', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ chatRealtimeDisabled: false });

    const wrapper = mount(Settings, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Эйсы');
    expect(wrapper.text()).toContain('групповой чат');
    expect(wrapper.text()).toContain('weekly digest');
  });

  it('shows BackButton on mount and hides on unmount', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ chatRealtimeDisabled: false });

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
});
