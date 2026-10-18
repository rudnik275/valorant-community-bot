<template>
  <RouterView v-if="insideTelegram" />
  <div v-else class="container">
    <div class="glass-panel open-in-telegram">
      <p>Это приложение работает только внутри Telegram — в браузере оно не узнает, кто ты.</p>
      <a class="btn-primary" :href="MINI_APP_LINK" data-testid="open-in-telegram">Открыть в Telegram</a>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch, isInsideTelegram } from './lib/api.ts';
import { MeResponseSchema } from '../shared/schemas/me.ts';
import { MINI_APP_LINK } from '../shared/mini-app-link.ts';

const router = useRouter();
// Opened from a bare https link → default browser, no initData, every API call
// answers 401. Point the person back into Telegram instead of showing that.
const insideTelegram = isInsideTelegram();

onMounted(async () => {
  if (!insideTelegram) return;
  try {
    const me = await apiFetch('/api/me', MeResponseSchema);
    if (!me.onboarded && router.currentRoute.value.name !== 'onboard') {
      await router.replace({ name: 'onboard' });
    }
  } catch (err) {
    console.warn('Failed to check /api/me:', err);
  }
});
</script>
<style scoped>
.open-in-telegram {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: flex-start;
}
.open-in-telegram .btn-primary {
  text-decoration: none;
}
</style>
