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

const mockOpenTelegramLink = vi.fn();
const mockOpenLink = vi.fn();
const mockWriteText = vi.fn().mockResolvedValue(undefined);

const MOCK_MEMBERS: Member[] = [
  {
    telegramId: 1,
    telegramUsername: 'alice',
    telegramAvatarUrl: 'https://example.com/alice.jpg',
    riotName: 'Alice',
    riotTag: '1337',
    riotCardId: null,
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
    riotCardId: null,
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
      { path: '/onboard', component: { template: '<div />' } },
    ],
  });
}

describe('MembersList.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenTelegramLink.mockReset();
    mockOpenLink.mockReset();
    mockWriteText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'Telegram', {
      value: { WebApp: { openTelegramLink: mockOpenTelegramLink, openLink: mockOpenLink } },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
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

  it('does NOT render .member-stats element', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.member-stats').exists()).toBe(false);
  });

  it('renders two-row layout: .member-riot above .member-username when both are set', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // alice has both riotName and telegramUsername
    const cards = wrapper.findAll('.member-card');
    const aliceCard = cards[0]!;
    expect(aliceCard.find('.member-riot').exists()).toBe(true);
    expect(aliceCard.find('.member-riot').text()).toContain('Alice#1337');
    expect(aliceCard.find('.member-username').exists()).toBe(true);
    expect(aliceCard.find('.member-username').text()).toContain('@alice');
  });

  it('renders only .member-username when no riot name', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, {
      global: { plugins: [makeRouter()] },
    });

    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // bob has no riotName, only telegramUsername
    const cards = wrapper.findAll('.member-card');
    const bobCard = cards[1]!;
    expect(bobCard.find('.member-riot').exists()).toBe(false);
    expect(bobCard.find('.member-username').exists()).toBe(true);
    expect(bobCard.find('.member-username').text()).toContain('@bob');
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

    // Both alice and bob have riotCardId: null, so neither gets a primary card img.
    // alice has telegramAvatarUrl → rendered as corner .tg-avatar-overlay img.
    const avatarCardImgs = wrapper.findAll('img.avatar-img--card');
    expect(avatarCardImgs).toHaveLength(0);
    const tgOverlayImgs = wrapper.findAll('img.tg-avatar-overlay');
    expect(tgOverlayImgs).toHaveLength(1);
    expect(tgOverlayImgs[0]!.attributes('src')).toBe('https://example.com/alice.jpg');
  });

  // ─── Avatar combination tests ─────────────────────────────────────────────

  it('avatar combo: riotCardId + telegramAvatarUrl → Valorant card primary + TG overlay (img)', async () => {
    const member: Member = {
      telegramId: 10,
      telegramUsername: 'combo1',
      telegramAvatarUrl: 'https://example.com/tg.jpg',
      riotName: 'Player',
      riotTag: '001',
      riotCardId: 'abc-uuid',
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([member]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img.avatar-img--card').exists()).toBe(true);
    expect(wrapper.find('img.avatar-img--card').attributes('src')).toContain('abc-uuid');
    expect(wrapper.find('img.tg-avatar-overlay').exists()).toBe(true);
    expect(wrapper.find('img.tg-avatar-overlay').attributes('src')).toBe('https://example.com/tg.jpg');
    expect(wrapper.find('.tg-avatar-overlay--placeholder').exists()).toBe(false);
  });

  it('avatar combo: riotCardId + no telegramAvatarUrl → Valorant card + placeholder overlay', async () => {
    const member: Member = {
      telegramId: 11,
      telegramUsername: 'combo2',
      telegramAvatarUrl: null,
      riotName: 'Player',
      riotTag: '002',
      riotCardId: 'abc-uuid',
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([member]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img.avatar-img--card').exists()).toBe(true);
    expect(wrapper.find('.tg-avatar-overlay--placeholder').exists()).toBe(true);
    expect(wrapper.find('.tg-avatar-overlay--placeholder').text()).toBe('P');
    expect(wrapper.find('img.tg-avatar-overlay').exists()).toBe(false);
  });

  it('avatar combo: no riotCardId + telegramAvatarUrl → ? placeholder primary + TG overlay (img)', async () => {
    const member: Member = {
      telegramId: 12,
      telegramUsername: 'combo3',
      telegramAvatarUrl: 'https://example.com/tg.jpg',
      riotName: null,
      riotTag: null,
      riotCardId: null,
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([member]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.avatar-placeholder--unlinked').exists()).toBe(true);
    expect(wrapper.find('.avatar-placeholder--unlinked').text()).toBe('?');
    expect(wrapper.find('img.avatar-img--card').exists()).toBe(false);
    expect(wrapper.find('img.tg-avatar-overlay').exists()).toBe(true);
    expect(wrapper.find('img.tg-avatar-overlay').attributes('src')).toBe('https://example.com/tg.jpg');
    expect(wrapper.find('.tg-avatar-overlay--placeholder').exists()).toBe(false);
  });

  it('avatar combo: no riotCardId + no telegramAvatarUrl → ? placeholder primary + initial-letter corner', async () => {
    const member: Member = {
      telegramId: 13,
      telegramUsername: 'combo4',
      telegramAvatarUrl: null,
      riotName: null,
      riotTag: null,
      riotCardId: null,
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([member]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.avatar-placeholder--unlinked').exists()).toBe(true);
    expect(wrapper.find('.avatar-placeholder--unlinked').text()).toBe('?');
    expect(wrapper.find('img.avatar-img--card').exists()).toBe(false);
    expect(wrapper.find('img.tg-avatar-overlay').exists()).toBe(false);
    expect(wrapper.find('.tg-avatar-overlay--placeholder').exists()).toBe(true);
  });

  it('renders both current and peak icons when currentTierId === peakTierId', async () => {
    const member: Member = {
      telegramId: 50,
      telegramUsername: 'equal_tier',
      telegramAvatarUrl: null,
      riotName: 'SameTier',
      riotTag: '0001',
      riotCardId: null,
      currentTierId: 18,
      currentTierName: 'Diamond 1',
      peakTierId: 18,
      peakTierName: 'Diamond 1',
      peakSeasonShort: 'e11a2',
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([member]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('img.rank-icon--current').exists()).toBe(true);
    expect(wrapper.find('img.rank-icon--current').attributes('src')).toBe('/ranks/18.png');
    expect(wrapper.find('img.rank-icon--peak').exists()).toBe(true);
    expect(wrapper.find('img.rank-icon--peak').attributes('src')).toBe('/ranks/18.png');
    expect(wrapper.findAll('img.rank-icon')).toHaveLength(2);
  });

  // ─── Action button tests ──────────────────────────────────────────────────

  it('click .member-copy-trigger writes Name#TAG to clipboard and shows toast', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const cards = wrapper.findAll('.member-card');
    const aliceCard = cards[0]!;
    const copyTrigger = aliceCard.find('.member-copy-trigger');
    expect(copyTrigger.exists()).toBe(true);

    await copyTrigger.trigger('click');
    await wrapper.vm.$nextTick();

    expect(mockWriteText).toHaveBeenCalledWith('Alice#1337');
    expect(wrapper.find('.toast-bubble').exists()).toBe(true);
    expect(wrapper.find('.toast-bubble').text()).toContain('Alice#1337 скопирован');
  });

  it('.member-copy-trigger for member without riotName is disabled and click does not write clipboard', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    // bob (index 1) has no riotName
    const cards = wrapper.findAll('.member-card');
    const bobCard = cards[1]!;
    const copyTrigger = bobCard.find('.member-copy-trigger');
    expect(copyTrigger.exists()).toBe(true);
    expect(copyTrigger.attributes('disabled')).toBeDefined();

    await copyTrigger.trigger('click');
    await wrapper.vm.$nextTick();

    expect(mockWriteText).not.toHaveBeenCalled();
    expect(wrapper.find('.toast-bubble').exists()).toBe(false);
  });

  it('click .action-tg calls openTelegramLink with https://t.me/<username> when username is set', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const cards = wrapper.findAll('.member-card');
    const aliceCard = cards[0]!;
    const tgBtn = aliceCard.find('.action-tg');
    expect(tgBtn.exists()).toBe(true);

    await tgBtn.trigger('click');

    expect(mockOpenTelegramLink).toHaveBeenCalledWith('https://t.me/alice');
    expect(mockOpenLink).not.toHaveBeenCalled();
  });

  it('.action-tg always renders (even without telegramUsername)', async () => {
    const memberNoUsername: Member = {
      telegramId: 99,
      telegramUsername: null,
      telegramAvatarUrl: null,
      riotName: 'NoUser',
      riotTag: '0000',
      riotCardId: null,
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([memberNoUsername]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const card = wrapper.find('.member-card');
    expect(card.find('.action-tg').exists()).toBe(true);
  });

  it('click .action-tg calls openLink with tg://user?id=<telegramId> when no username', async () => {
    const memberNoUsername: Member = {
      telegramId: 12345,
      telegramUsername: null,
      telegramAvatarUrl: null,
      riotName: 'NoUser',
      riotTag: '0000',
      riotCardId: null,
      currentTierId: null,
      currentTierName: null,
      peakTierId: null,
      peakTierName: null,
      peakSeasonShort: null,
      lastMessageAt: null,
    };
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue([memberNoUsername]);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const card = wrapper.find('.member-card');
    const tgBtn = card.find('.action-tg');
    expect(tgBtn.exists()).toBe(true);

    await tgBtn.trigger('click');

    expect(mockOpenLink).toHaveBeenCalledWith('tg://user?id=12345');
    expect(mockOpenTelegramLink).not.toHaveBeenCalled();
  });

  it('clicking card body does not trigger openTelegramLink', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const card = wrapper.find('.member-card');
    await card.trigger('click');

    expect(mockOpenTelegramLink).not.toHaveBeenCalled();
  });

  // ─── Hover spotlight tests ────────────────────────────────────────────────

  it('pointermove on .member-card updates --mouse-x and --mouse-y inline styles', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MEMBERS);

    const wrapper = mount(MembersList, { global: { plugins: [makeRouter()] } });
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();

    const card = wrapper.find('.member-card');
    const cardEl = card.element as HTMLElement;

    // Simulate a pointermove event at a specific offset within the card.
    // jsdom clientWidth/clientHeight are 0 in unit tests, so offsetX=0, clientWidth=0
    // avoids division by zero — we test that setProperty is called correctly.
    Object.defineProperty(cardEl, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(cardEl, 'clientHeight', { value: 80, configurable: true });

    await card.trigger('pointermove', { offsetX: 100, offsetY: 40 });

    expect(cardEl.style.getPropertyValue('--mouse-x')).toBe('50%');
    expect(cardEl.style.getPropertyValue('--mouse-y')).toBe('50%');
  });
});
