// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import Onboard from './Onboard.vue';
import MembersList from './MembersList.vue';

// Onboard.vue is a static "Riot Sign-On coming soon" splash during the
// Henrik -> Riot+RSO transition (issue #41). The previous form-and-fetch
// tests were retired together with the Henrik input flow; the real RSO
// flow ships in issue #43 and will bring its own e2e test suite.

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'members', component: MembersList },
      { path: '/onboard', name: 'onboard', component: Onboard },
    ],
  });
}

describe('Onboard.vue (RSO-pending splash)', () => {
  it('renders the closed-alpha badge and the "coming soon" headline', () => {
    const wrapper = mount(Onboard, { global: { plugins: [makeRouter()] } });

    expect(wrapper.text()).toContain('Closed alpha');
    expect(wrapper.text()).toContain('Riot Sign-On is on the way');
  });

  it('does not render the old Riot-ID form or any input', () => {
    const wrapper = mount(Onboard, { global: { plugins: [makeRouter()] } });

    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('links to the public landing page for more info', () => {
    const wrapper = mount(Onboard, { global: { plugins: [makeRouter()] } });

    const link = wrapper.find('a[href="/about"]');
    expect(link.exists()).toBe(true);
  });
});
