<template>
  <div class="members-list">
    <div class="members-header">
      <router-link to="/settings" class="settings-link">⚙</router-link>
    </div>
    <div v-if="loading">Загрузка...</div>
    <div v-else-if="error">Ошибка: {{ error }}</div>
    <div v-else-if="members.length === 0">Пока никто не писал в чат</div>
    <ul v-else>
      <li v-for="m in members" :key="m.telegramId" @click="openProfile(m.telegramId)">
        <img v-if="m.telegramAvatarUrl" :src="m.telegramAvatarUrl" :alt="m.telegramUsername ?? ''" />
        <div class="info">
          <div class="name">{{ m.riotName ? `${m.riotName}#${m.riotTag}` : `@${m.telegramUsername ?? 'unknown'}` }}</div>
          <div class="rank">{{ m.currentRank ?? '—' }}</div>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiFetch } from '../lib/api.ts';
import { MembersResponseSchema, type Member } from '../../shared/schemas/members.ts';

const members = ref<Member[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    members.value = await apiFetch('/api/members', MembersResponseSchema);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

function openProfile(telegramId: number) {
  const url = `tg://user?id=${telegramId}`;
  (window as Window & { Telegram?: { WebApp?: { openTelegramLink?: (url: string) => void } } }).Telegram?.WebApp?.openTelegramLink?.(url);
}
</script>
