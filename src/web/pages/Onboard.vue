<template>
  <div class="onboard-page">
    <h1>Привязать Riot ID</h1>
    <p class="hint">Введи свой Riot ID в формате <code>Имя#TAG</code></p>

    <form @submit.prevent="handleSubmit">
      <div class="field">
        <input
          v-model="riotIdInput"
          type="text"
          placeholder="YourName#TAG"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        />
      </div>

      <button type="submit" :disabled="loading || !riotIdInput.trim()">
        {{ loading ? 'Загрузка...' : 'Привязать' }}
      </button>
    </form>

    <div v-if="errorMessage" class="error" data-testid="error">{{ errorMessage }}</div>
    <div v-if="successMessage" class="success" data-testid="success">{{ successMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const riotIdInput = ref('');
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const successMessage = ref<string | null>(null);

function getInitDataRaw(): string {
  if (typeof window === 'undefined') return '';
  const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return tg?.WebApp?.initData ?? '';
}

async function handleSubmit() {
  errorMessage.value = null;
  successMessage.value = null;

  const raw = riotIdInput.value.trim();
  if (!raw) return;

  const hashIndex = raw.indexOf('#');
  let name: string;
  let tag: string;

  if (hashIndex > 0 && hashIndex < raw.length - 1) {
    name = raw.slice(0, hashIndex);
    tag = raw.slice(hashIndex + 1);
  } else {
    errorMessage.value = 'Введи Riot ID в формате Имя#TAG';
    return;
  }

  loading.value = true;

  try {
    const res = await fetch('/api/onboard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `tma ${getInitDataRaw()}`,
      },
      body: JSON.stringify({ name, tag }),
    });

    const body: unknown = await res.json();

    if (!res.ok) {
      handleApiError(res.status, body as Record<string, unknown>);
      return;
    }

    // Success — haptic feedback + success message + redirect
    const tg = (window as Window & { Telegram?: { WebApp?: { HapticFeedback?: { notificationOccurred: (type: string) => void } } } }).Telegram;
    tg?.WebApp?.HapticFeedback?.notificationOccurred('success');

    successMessage.value = 'Готово!';

    setTimeout(() => {
      void router.replace({ name: 'members' });
    }, 2000);
  } catch (err) {
    errorMessage.value = `Ошибка: ${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
}

function handleApiError(status: number, body: Record<string, unknown>) {
  const error = body?.error as string | undefined;

  if (status === 404 || error === 'riot_id_not_found') {
    errorMessage.value = 'Riot ID не найден. Проверь правильность ввода.';
  } else if (status === 503 || error === 'henrik_rate_limited') {
    const retryAfter = body?.retryAfter as number | undefined;
    errorMessage.value = retryAfter
      ? `Henrik API перегружен, попробуй через ${retryAfter} секунд`
      : 'Henrik API перегружен, попробуй позже';
  } else if (status === 409 || error === 'puuid_already_linked') {
    const other = (body?.other as string | undefined) ?? 'другим пользователем';
    errorMessage.value = `Этот Riot ID уже привязан к ${other}`;
  } else if (error === 'bot_lacks_admin_rights') {
    errorMessage.value = 'Боту нужны admin-права в группе — обратись к владельцу';
  } else {
    errorMessage.value = `Ошибка ${status}: что-то пошло не так`;
  }
}
</script>
