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
      <div v-if="me.profile.currentRank || me.profile.peakRank" class="rank-row" data-testid="rank-row">
        <div v-if="me.profile.currentRank" class="rank-pill" data-testid="current-rank">
          <img :src="`/ranks/${me.profile.currentRank.tierId}.png`" :alt="me.profile.currentRank.tierName" class="rank-icon" />
          <span>{{ me.profile.currentRank.tierName }}</span>
        </div>
        <div v-if="me.profile.peakRank && me.profile.peakRank.tierId !== me.profile.currentRank?.tierId" class="rank-pill rank-pill--peak" data-testid="peak-rank">
          <img :src="`/ranks/${me.profile.peakRank.tierId}.png`" :alt="me.profile.peakRank.tierName" class="rank-icon" />
          <span>Пик: {{ me.profile.peakRank.tierName }}<template v-if="me.profile.peakRank.seasonShort"> ({{ me.profile.peakRank.seasonShort }})</template></span>
        </div>
      </div>
      <p v-if="me.profile.region" class="text-muted region-label" data-testid="region-label">
        Регион: {{ me.profile.region.toUpperCase() }}
      </p>
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

.rank-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.rank-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: 13px;
}
.rank-pill--peak { opacity: 0.75; }
.rank-pill .rank-icon { width: 22px; height: 22px; object-fit: contain; }
.region-label { font-size: 12px; margin-top: 8px; }
</style>
