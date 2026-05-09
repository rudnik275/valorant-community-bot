import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import MembersList from './pages/MembersList.vue';

// Try to initialise Telegram Mini App SDK — no-op when running outside Telegram
function initTelegramSdk(): void {
  import('@telegram-apps/sdk')
    .then(({ mountViewport, expandViewport }) => {
      return mountViewport().then(() => {
        expandViewport();
      });
    })
    .catch((err) => {
      console.warn('Telegram SDK init failed — running outside Telegram:', err);
    });
}

initTelegramSdk();

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', name: 'members', component: MembersList }],
});

createApp(App).use(router).mount('#app');
