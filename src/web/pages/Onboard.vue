<template>
  <div class="onboard-page">
    <h1 class="onboard-title">Привязать аккаунт Riot</h1>

    <p class="onboard-hint">
      Введи своё Riot имя и тег — бот найдёт твой аккаунт и начнёт отслеживать матчи.
    </p>

    <form v-if="!success" class="onboard-form" @submit.prevent="onSubmit">
      <div class="riot-id-row">
        <input
          v-model="name"
          class="riot-input riot-name"
          type="text"
          placeholder="Riot Name"
          maxlength="16"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          data-testid="input-name"
        />
        <span class="riot-separator">#</span>
        <input
          v-model="tag"
          class="riot-input riot-tag"
          type="text"
          placeholder="1234"
          maxlength="5"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          data-testid="input-tag"
        />
      </div>

      <p v-if="validationError" class="onboard-error" data-testid="validation-error">
        {{ validationError }}
      </p>

      <button
        type="submit"
        class="onboard-btn"
        :disabled="loading"
        data-testid="submit-btn"
      >
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        {{ loading ? 'Проверяем…' : 'Привязать аккаунт' }}
      </button>

      <p v-if="apiError" class="onboard-error" data-testid="api-error">
        {{ apiError }}
      </p>
    </form>

    <div v-else class="onboard-success" data-testid="success-message">
      Аккаунт привязан: {{ linkedName }}#{{ linkedTag }} ({{ linkedRegion }})
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { z } from 'zod';

const name = ref('');
const tag = ref('');
const loading = ref(false);
const validationError = ref<string | null>(null);
const apiError = ref<string | null>(null);
const success = ref(false);
const linkedName = ref('');
const linkedTag = ref('');
const linkedRegion = ref('');

const ClientBodySchema = z.object({
  name: z.string().min(1, 'Введи Riot Name').max(16),
  tag: z.string().min(1, 'Введи тег').max(5).regex(/^[a-zA-Z0-9]+$/, 'Тег — только буквы и цифры'),
});

function getInitDataRaw(): string {
  if (typeof window === 'undefined') return '';
  const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  const raw = tg?.WebApp?.initData ?? '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

const ERROR_MESSAGES: Record<string, string> = {
  account_not_found: 'Аккаунт Riot не найден. Проверьте написание.',
  rate_limited: 'Слишком много запросов. Попробуйте через минуту.',
  puuid_already_linked: 'Этот Riot аккаунт уже привязан к другому Telegram.',
  henrik_upstream: 'Сервер Henrik временно недоступен.',
};

async function onSubmit() {
  validationError.value = null;
  apiError.value = null;

  const parsed = ClientBodySchema.safeParse({ name: name.value.trim(), tag: tag.value.trim() });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    validationError.value = firstIssue?.message ?? 'Заполни все поля.';
    return;
  }

  loading.value = true;
  try {
    const initDataRaw = getInitDataRaw();
    const res = await fetch('/api/onboard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `tma ${initDataRaw}`,
      },
      body: JSON.stringify({ name: parsed.data.name, tag: parsed.data.tag }),
    });

    if (res.ok) {
      const body = await res.json() as { riot_name: string; riot_tag: string; riot_region: string };
      linkedName.value = body.riot_name;
      linkedTag.value = body.riot_tag;
      linkedRegion.value = body.riot_region;
      success.value = true;
    } else {
      let errorCode = 'unknown';
      try {
        const errBody = await res.json() as { error?: string };
        errorCode = errBody.error ?? 'unknown';
      } catch {
        // ignore parse error
      }
      apiError.value = ERROR_MESSAGES[errorCode] ?? 'Что-то пошло не так. Попробуйте ещё раз.';
    }
  } catch {
    apiError.value = 'Что-то пошло не так. Попробуйте ещё раз.';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.onboard-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 16px;
  max-width: 480px;
  margin: 0 auto;
  background-color: var(--tg-theme-bg-color, #ffffff);
  color: var(--tg-theme-text-color, #000000);
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
}

.onboard-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.onboard-hint {
  font-size: 14px;
  line-height: 1.5;
  color: var(--tg-theme-hint-color, #8e8e93);
  margin: 0;
}

.onboard-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.riot-id-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.riot-input {
  padding: 10px 12px;
  border: 1px solid var(--tg-theme-hint-color, #ccc);
  border-radius: 8px;
  font-size: 15px;
  background: var(--tg-theme-secondary-bg-color, #f2f2f7);
  color: var(--tg-theme-text-color, #000000);
  outline: none;
}

.riot-input:focus {
  border-color: var(--tg-theme-button-color, #2481cc);
}

.riot-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.riot-name {
  flex: 1;
  min-width: 0;
}

.riot-tag {
  width: 80px;
  flex-shrink: 0;
}

.riot-separator {
  font-size: 18px;
  font-weight: 600;
  color: var(--tg-theme-hint-color, #8e8e93);
  line-height: 1;
  user-select: none;
}

.onboard-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: none;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  background-color: var(--tg-theme-button-color, #2481cc);
  color: var(--tg-theme-button-text-color, #ffffff);
  transition: opacity 0.15s;
}

.onboard-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.onboard-error {
  font-size: 14px;
  color: var(--tg-theme-destructive-text-color, #e53e3e);
  margin: 0;
}

.onboard-success {
  font-size: 15px;
  font-weight: 500;
  color: #5be3a4;
  padding: 16px;
  border-radius: 10px;
  background: rgba(91, 227, 164, 0.1);
  text-align: center;
}
</style>
