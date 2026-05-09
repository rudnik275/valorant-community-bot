<template>
  <div class="settings-page">
    <h1 class="settings-title">Настройки</h1>

    <div class="settings-row">
      <label class="switch-label" for="chat-realtime-toggle">
        Не показывать мои события в чате
      </label>
      <label class="switch">
        <input
          id="chat-realtime-toggle"
          type="checkbox"
          :checked="chatRealtimeDisabled"
          :disabled="loading"
          @change="onToggle"
        />
        <span class="slider"></span>
      </label>
    </div>

    <p class="settings-hint">
      Эйсы, клатчи, винстрики и прочие моменты не будут попадать в групповой чат.
      В weekly digest по-прежнему попадают, но обезличенно (агрегаты).
    </p>

    <div v-if="error" class="settings-error" data-testid="settings-error">
      {{ error }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch } from '../lib/api.ts';
import { SettingsSchema } from '../../shared/schemas/settings.ts';

const router = useRouter();
const chatRealtimeDisabled = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);

type TelegramWebApp = {
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (fn: () => void) => void;
    offClick: (fn: () => void) => void;
  };
  HapticFeedback?: {
    impactOccurred: (style: string) => void;
  };
};

function getTwa(): TelegramWebApp | undefined {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

function goBack() {
  void router.push('/');
}

onMounted(async () => {
  getTwa()?.BackButton?.show();
  getTwa()?.BackButton?.onClick(goBack);

  try {
    loading.value = true;
    const settings = await apiFetch('/api/me/settings', SettingsSchema);
    chatRealtimeDisabled.value = settings.chatRealtimeDisabled;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  getTwa()?.BackButton?.offClick(goBack);
  getTwa()?.BackButton?.hide();
});

async function onToggle(event: Event) {
  const newValue = (event.target as HTMLInputElement).checked;

  getTwa()?.HapticFeedback?.impactOccurred('light');

  const previousValue = chatRealtimeDisabled.value;
  chatRealtimeDisabled.value = newValue;
  loading.value = true;
  error.value = null;

  try {
    const updated = await apiFetch('/api/me/settings', SettingsSchema, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatRealtimeDisabled: newValue }),
    });
    chatRealtimeDisabled.value = updated.chatRealtimeDisabled;
  } catch (err) {
    // Revert on failure
    chatRealtimeDisabled.value = previousValue;
    error.value = 'Ошибка сохранения. Попробуйте ещё раз.';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.settings-page {
  padding: 16px;
  background-color: var(--tg-theme-bg-color, #ffffff);
  color: var(--tg-theme-text-color, #000000);
  min-height: 100vh;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.switch-label {
  font-size: 15px;
  flex: 1;
  padding-right: 12px;
  cursor: pointer;
}

/* Toggle switch */
.switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 28px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: #ccc;
  border-radius: 28px;
  transition: background-color 0.2s;
}

.slider::before {
  content: '';
  position: absolute;
  width: 22px;
  height: 22px;
  left: 3px;
  bottom: 3px;
  background-color: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

input:checked + .slider {
  background-color: var(--tg-theme-button-color, #2481cc);
}

input:checked + .slider::before {
  transform: translateX(20px);
}

input:disabled + .slider {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-hint {
  font-size: 13px;
  color: var(--tg-theme-hint-color, #8e8e93);
  line-height: 1.4;
  margin-bottom: 16px;
}

.settings-error {
  color: var(--tg-theme-destructive-text-color, #e53e3e);
  font-size: 14px;
  margin-top: 8px;
}
</style>
