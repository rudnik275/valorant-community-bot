<template>
  <div class="container onboard-page">
    <h1 class="h1">Привязка Riot ID</h1>

    <p class="text-muted onboard-hint">
      Введи своё Riot имя и тег — бот найдёт твой аккаунт и начнёт отслеживать матчи.
    </p>

    <form v-if="!success" class="card onboard-form" @submit.prevent="onSubmit">
      <div class="riot-id-row">
        <input
          v-model="name"
          class="input-glass riot-name"
          type="text"
          placeholder="Riot Name"
          maxlength="16"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          tabindex="1"
          data-testid="input-name"
        />
        <span class="riot-separator">#</span>
        <input
          v-model="tag"
          class="input-glass riot-tag"
          type="text"
          placeholder="1234"
          maxlength="5"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          tabindex="2"
          data-testid="input-tag"
        />
      </div>

      <p v-if="validationError" class="list-item-dotted list-item-dotted--no onboard-error" data-testid="validation-error">
        {{ validationError }}
      </p>

      <button
        type="submit"
        class="btn-primary onboard-btn"
        :class="{ 'onboard-btn--loading': loading }"
        :disabled="loading"
        tabindex="3"
        data-testid="submit-btn"
      >
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        {{ loading ? 'Проверяем…' : 'Привязать аккаунт' }}
      </button>

      <div v-if="apiError" class="glass-panel onboard-api-error" data-testid="api-error">
        <p class="list-item-dotted list-item-dotted--no">{{ apiError }}</p>
      </div>
    </form>

    <div v-else class="card onboard-success" data-testid="success-message">
      <p class="h2-section">Готово</p>
      <p class="onboard-success-text">Аккаунт привязан: {{ linkedName }}#{{ linkedTag }} ({{ linkedRegion }})</p>
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
  account_inactive: 'Аккаунт найден, но Riot не показывает по нему свежих матчей. Сыграй один матч (можно Deathmatch) и попробуй снова — после игры всё подтянется.',
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
  gap: 24px;
  padding-top: 32px;
  padding-bottom: 32px;
  min-height: 100vh;
}

.onboard-hint {
  margin: 0;
}

.onboard-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.riot-id-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Name input takes all remaining space */
.riot-name {
  flex: 1;
  min-width: 0;
}

/* Tag input fixed narrow width */
.riot-tag {
  width: 88px;
  flex-shrink: 0;
}

.riot-separator {
  font-size: 18px;
  font-weight: 600;
  color: var(--muted);
  line-height: 1;
  user-select: none;
  flex-shrink: 0;
}

/* Submit button — full width inside the card */
.onboard-btn {
  width: 100%;
  padding: 12px 20px;
  font-size: 15px;
}

/* Loading pulse animation on the button */
.onboard-btn--loading {
  animation: btn-pulse 1.2s ease-in-out infinite;
  cursor: not-allowed;
}

@keyframes btn-pulse {
  0%, 100% { opacity: 0.7; }
  50%       { opacity: 0.45; }
}

.onboard-error {
  margin: 0;
}

/* Error panel — no extra margin-bottom from .glass-panel default */
.onboard-api-error {
  margin-bottom: 0;
  padding: 14px 16px;
  border-radius: 14px;
}

.onboard-api-error p {
  margin: 0;
}

/* Spinner inside button */
.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Success card */
.onboard-success {
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-align: center;
}

.onboard-success-text {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--status-online);
}
</style>
