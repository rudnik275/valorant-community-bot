<template>
  <div class="container">
    <h1 class="h1" style="margin-bottom: 28px;">Настройки</h1>

    <!-- Linked account card -->
    <div v-if="loadingMe" class="card" data-testid="loading">
      <p class="text-muted">Загрузка…</p>
    </div>

    <div v-else-if="me && me.onboarded && me.profile" class="card" data-testid="linked-account">
      <h2 class="h2-section" style="margin-bottom: 14px;">Привязанный аккаунт</h2>
      <p class="h3-card" data-testid="riot-name-tag">
        {{ me.profile.riotName }}#{{ me.profile.riotTag }}
      </p>
      <!-- TODO: surface current rank here once /api/me includes Henrik MMR lookup -->
    </div>

    <div v-else class="card" data-testid="not-linked">
      <h2 class="h2-section" style="margin-bottom: 14px;">Аккаунт не привязан</h2>
      <button class="btn-primary" @click="openOnboarding">
        Открыть онбординг
      </button>
    </div>

    <div v-if="meError" class="me-error" data-testid="me-error">
      {{ meError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch } from '../lib/api.ts';
import { MeResponseSchema } from '../../shared/schemas/me.ts';
import type { z } from 'zod';

type MeResponse = z.infer<typeof MeResponseSchema>;

const router = useRouter();
const me = ref<MeResponse | null>(null);
const loadingMe = ref(false);
const meError = ref<string | null>(null);

type TelegramWebApp = {
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
  };
};

function getTwa(): TelegramWebApp | undefined {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

function goBack() {
  void router.push('/');
}

function openOnboarding() {
  void router.push('/');
}

onMounted(async () => {
  getTwa()?.BackButton?.show();
  getTwa()?.BackButton?.onClick(goBack);

  try {
    loadingMe.value = true;
    me.value = await apiFetch('/api/me', MeResponseSchema);
  } catch (err) {
    meError.value = (err as Error).message;
  } finally {
    loadingMe.value = false;
  }
});

onUnmounted(() => {
  getTwa()?.BackButton?.offClick(goBack);
  getTwa()?.BackButton?.hide();
});
</script>

<style scoped>
.me-error {
  color: var(--status-warn, #e53e3e);
  font-size: 14px;
  margin-top: 12px;
}
</style>
