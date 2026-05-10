// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import MembersList from './MembersList.vue';
import type { Member } from '../../shared/schemas/members.ts';

// Mock the api module
vi.mock('../lib/api.ts', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../lib/api.ts';

const MOCK_MEMBERS: Member[] = [
  {
    telegramId: 1,
    telegramUsername: 'alice',
    telegramAvatarUrl: 'https://example.com/alice.jpg',
    riotName: 'Alice',
    riotTag: '1337',
    currentTierId: 15,
    currentTierName: 'Platinum 1',
    peakTierId: 18,
    peakTierName: 'Diamond 1',
    peakSeasonShort: 'e11a2',
    lastMessageAt: '2026-05-09T10:00:00.000Z',
  },
  {
    telegramId: 2,
    telegramUsername: 'bob',
    telegramAvatarUrl: null,
    riotName: null,
    riotTag: null,
    currentTierId: null,
    currentTierName: null,
    peakTierId: null,
    peakTierName: null,
    peakSeasonShort: null,
    lastMessageAt: null,
  },
];

// Minimal router for RouterView if needed
function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', component: MembersList },
      { path: '/settings', component: { template: '<div />' } },
    ],
  });
}

describe('MembersList.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', async () => {
    // Return a promise that never resolves during this test
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    expect(wrapper.text()).toContain('Загрузка');
  });

  it('renders member cards from the API response', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    // Wait for onMounted async to settle
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const items = wrapper.findAll('.member-card');
    expect(items).toHaveLength(2);
  });

  it('renders riot name#tag for onboarded users', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Alice#1337');
  });

  it('renders @username for non-onboarded users', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('@bob');
  });

  it('renders rank for onboarded users', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // Rank is rendered as an <img src="/ranks/{tierId}.png">, not as text
    const rankImgs = wrapper.findAll('img.rank-icon');
    expect(rankImgs.length).toBeGreaterThanOrEqual(1);
    const currentRankSrc = rankImgs.map(i => i.attributes('src'));
    expect(currentRankSrc).toContain('/ranks/15.png'); // Platinum 1 = tier id 15
  });

  it('does NOT show lastMessageAt in the DOM', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // lastMessageAt should never appear in the rendered HTML
    expect(wrapper.text()).not.toContain('2026-05-09');
    expect(wrapper.text()).not.toContain('lastMessageAt');
    expect(wrapper.text()).not.toContain('10:00');
  });

  it('does NOT show K/D or winrate in the DOM', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const html = wrapper.html();
    expect(html).not.toContain('kills');
    expect(html).not.toContain('deaths');
    expect(html).not.toContain('winrate');
    expect(html).not.toContain('K/D');
    expect(html).not.toContain('Win');
  });

  it('shows empty state when members list is empty', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Пока никто не писал в чат');
  });

  it('shows error state when API fails', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API /api/members failed: 401'));

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Ошибка');
  });

  it('renders avatar img for users with avatarUrl', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const avatarImgs = wrapper.findAll('img.avatar-img');
    // Only alice has a Telegram avatar
    expect(avatarImgs).toHaveLength(1);
    expect(avatarImgs[0]!.attributes('src')).toBe('https://example.com/alice.jpg');
  });
});
