<template>
  <div class="container onboard-page">
    <h1 class="h1">{{ isJoinFlow ? 'Вступление в чат' : 'Привязка Riot ID' }}</h1>

    <p class="text-muted onboard-hint">
      <template v-if="isJoinFlow">
        Введи свой Riot ID — по нему в чате будет видно, кто ты в игре.
        Сменишь ник в Valorant, и здесь он обновится сам.
      </template>
      <template v-else>
        Введи своё Riot имя и тег — бот найдёт твой аккаунт и начнёт отслеживать матчи.
      </template>
    </p>

    <!--
      `maxlength` is deliberately looser than the real 16/5 limits: it counts
      UTF-16 units, so decomposed input (mobile keyboards emit `ё` as two units)
      would be silently truncated mid-typing. OnboardBodySchema normalizes to NFC
      and then enforces the real limit with a message the user can act on.
    -->
    <form v-if="!success" class="card onboard-form" @submit.prevent="onSubmit">
      <div class="riot-id-row">
        <input
          v-model="name"
          class="input-glass riot-name"
          type="text"
          placeholder="Riot Name"
          maxlength="32"
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
          maxlength="10"
          :disabled="loading"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          tabindex="2"
          data-testid="input-tag"
        />
      </div>

      <!--
        Shown BEFORE any mistake, not just after one. Observed 2026-08-29: a new
        member guessed his own tag three times in a row and got three refusals
        before copying it from the client. The advice only helped once it was
        too late to be advice.
      -->
      <p class="text-muted onboard-copy-hint">
        Скопируй прямо из клиента Valorant — тег легко перепутать.
      </p>

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
        {{ loading ? 'Проверяем…' : (isJoinFlow ? 'Войти в чат' : 'Привязать аккаунт') }}
      </button>

      <div v-if="apiError" class="glass-panel onboard-api-error" data-testid="api-error">
        <template v-if="apiErrorCode === 'account_not_found'">
          <p class="onboard-error-headline">Аккаунт Riot не найден</p>
          <p class="onboard-error-sub">
            Имя и тег должны совпадать с клиентом Valorant один-в-один — регистр и язык каждого символа имеют значение.
          </p>
          <ul class="onboard-error-list">
            <li class="list-item-dotted list-item-dotted--no">латинская <b>I</b> (Shift+i) ≠ строчная <b>l</b></li>
            <li class="list-item-dotted list-item-dotted--no">кириллическая <b>І</b> ≠ латинская <b>I</b></li>
            <li class="list-item-dotted list-item-dotted--no">буква <b>O</b> ≠ цифра <b>0</b></li>
          </ul>
          <p class="onboard-error-hint">Лучше скопируй Riot ID прямо из клиента Valorant.</p>
        </template>
        <p v-else class="list-item-dotted list-item-dotted--no">{{ apiError }}</p>
      </div>
    </form>

    <div v-else class="card onboard-success" data-testid="success-message">
      <p class="h2-section">Готово</p>

      <!-- Verified link — the only case we can state as fact. -->
      <p v-if="!pendingReason" class="onboard-success-text">
        Аккаунт привязан: {{ linkedName }}#{{ linkedTag }} ({{ linkedRegion }})
      </p>

      <!-- Henrik confirmed the account exists, it just has no recent matches. -->
      <p v-else-if="pendingReason === 'inactive'" class="onboard-success-text">
        Ник принят: {{ linkedName }}#{{ linkedTag }}
      </p>

      <!-- Admitted on trust. Say so plainly: if the nick has a typo the bot will
           restrict access later, and an unexplained mute reads as a bug. -->
      <p v-else class="onboard-success-text">
        Ник принят: {{ linkedName }}#{{ linkedTag }}
      </p>

      <p v-if="pendingReason === 'inactive'" class="onboard-success-sub" data-testid="pending-inactive">
        Свежих матчей пока не видно — подтянем автоматически, как появятся.
      </p>

      <p v-else-if="pendingReason === 'henrik_unreachable'" class="onboard-success-sub" data-testid="pending-unreachable">
        Проверить ник прямо сейчас не вышло — сервис статистики недоступен.
        Мы поверили на слово и пустили. Перепроверим позже: если в нике опечатка,
        бот напишет и попросит ввести заново.
      </p>

      <p v-if="isJoinFlow" class="onboard-success-sub" data-testid="join-done">
        Можешь возвращаться в чат — доступ открыт.
      </p>
      <button
        v-else
        type="button"
        class="btn-primary onboard-btn"
        data-testid="continue-btn"
        @click="router.push({ name: 'members' })"
      >
        Продолжить
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { OnboardBodySchema } from '../../shared/schemas/onboard.ts';

const router = useRouter();

const name = ref('');
const tag = ref('');
const loading = ref(false);
const validationError = ref<string | null>(null);
const apiError = ref<string | null>(null);
const apiErrorCode = ref<string | null>(null);
const success = ref(false);
const linkedName = ref('');
const linkedTag = ref('');
const linkedRegion = ref('');
/** null ⇒ fully verified link; otherwise why the nick was accepted unresolved. */
const pendingReason = ref<'inactive' | 'henrik_unreachable' | null>(null);

/**
 * True when this Mini App session was opened from a join request (guard-bot
 * flow) rather than from inside the group. Telegram puts the query id in
 * initData; the SERVER re-reads it from the HMAC-validated string, so this
 * unvalidated client-side read only drives copy — never authorisation.
 */
const isJoinFlow = ((): boolean => {
  if (typeof window === 'undefined') return false;
  const tg = (window as Window & {
    Telegram?: { WebApp?: { initDataUnsafe?: { chat_join_request_query_id?: string } } };
  }).Telegram;
  return Boolean(tg?.WebApp?.initDataUnsafe?.chat_join_request_query_id);
})();

/**
 * Map a Zod issue to Russian copy.
 *
 * Deliberately keyed on the *length* codes only, with every other code falling
 * through to the format message: Zod renames its format codes between versions
 * (`invalid_string` → `invalid_format`), and the old `=== 'invalid_string'`
 * check would have started silently showing the wrong message on a bump.
 */
function getValidationMessage(issues: { path: (string | number)[]; code: string }[]): string {
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '');
    if (field === 'name') {
      if (issue.code === 'too_big') return 'Riot Name — не больше 16 символов';
      return 'Введи Riot Name';
    }
    if (field === 'tag') {
      if (issue.code === 'too_small') return 'Введи тег';
      if (issue.code === 'too_big') return 'Тег — не больше 5 символов';
      return 'Тег — буквы и цифры, без пробелов и #';
    }
  }
  return 'Заполни все поля.';
}

function getInitDataRaw(): string {
  if (typeof window === 'undefined') return '';
  const tg = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  const raw = tg?.WebApp?.initData ?? '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

const ERROR_MESSAGES: Record<string, string> = {
  account_not_found: 'Аккаунт Riot не найден.',
  rate_limited: 'Слишком много запросов. Попробуйте через минуту.',
  puuid_already_linked: 'Этот Riot аккаунт уже привязан к другому Telegram.',
  henrik_upstream: 'Сервер Henrik временно недоступен.',
};

async function onSubmit() {
  validationError.value = null;
  apiError.value = null;
  apiErrorCode.value = null;

  // Raw values — the schema owns trimming/normalization so client and server sanitize identically.
  const parsed = OnboardBodySchema.safeParse({ name: name.value, tag: tag.value });
  if (!parsed.success) {
    validationError.value = getValidationMessage(parsed.error.issues);
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
      const body = await res.json() as {
        riot_name: string;
        riot_tag: string;
        riot_region: string | null;
        pending?: boolean;
        pending_reason?: 'inactive' | 'henrik_unreachable';
      };
      linkedName.value = body.riot_name;
      linkedTag.value = body.riot_tag;
      linkedRegion.value = body.riot_region ?? '';
      // A pending nick used to bounce straight to the members list with no
      // explanation. That is no longer acceptable: since onboard admits on
      // Henrik-side failures, «pending» can mean «we never checked this», and
      // the user has to know that before a later re-gate surprises them.
      pendingReason.value = body.pending ? (body.pending_reason ?? 'inactive') : null;
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
      apiErrorCode.value = errorCode;
    }
  } catch {
    apiError.value = 'Что-то пошло не так. Попробуйте ещё раз.';
    apiErrorCode.value = 'unknown';
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

.onboard-copy-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
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

.onboard-error-headline {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}

.onboard-error-sub {
  margin-top: 6px !important;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}

.onboard-error-list {
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}

.onboard-error-hint {
  margin-top: 12px !important;
  font-size: 13px;
  line-height: 1.45;
  color: var(--fg);
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

.onboard-success-sub {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
</style>
