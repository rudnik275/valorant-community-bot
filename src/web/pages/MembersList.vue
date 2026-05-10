<template>
  <div class="container">
    <div v-if="loading" class="state-center">
      <span class="text-muted">Загрузка...</span>
    </div>

    <div v-else-if="error" class="glass-panel">
      <span class="list-item-dotted list-item-dotted--no">Ошибка: {{ error }}</span>
    </div>

    <div v-else-if="members.length === 0" class="glass-panel">
      <span class="text-muted">Пока никто не писал в чат</span>
    </div>

    <div v-else class="members-cards">
      <div
        v-for="m in members"
        :key="m.telegramId"
        class="card member-card"
        @pointermove="onCardPointerMove"
      >
        <!-- Left-half copy trigger: avatar + name -->
        <button
          type="button"
          class="member-copy-trigger"
          :aria-label="m.riotName ? `Скопировать ${m.riotName}#${m.riotTag}` : 'Без Riot ID'"
          :disabled="!m.riotName"
          @click="copyRiotId(m, $event)"
        >
          <!-- Avatar -->
          <div class="member-avatar">
            <!-- Primary: Valorant card or ? placeholder -->
            <img
              v-if="m.riotCardId"
              :src="valorantCardUrl(m.riotCardId)"
              :alt="m.riotName ?? ''"
              class="avatar-img avatar-img--card"
            />
            <div v-else class="avatar-placeholder avatar-placeholder--unlinked">?</div>

            <!-- Corner: always rendered. TG avatar or initial-letter circle. -->
            <img
              v-if="m.telegramAvatarUrl"
              :src="m.telegramAvatarUrl"
              :alt="m.telegramUsername ?? ''"
              class="tg-avatar-overlay"
            />
            <div v-else class="tg-avatar-overlay tg-avatar-overlay--placeholder">
              {{ avatarInitial(m) }}
            </div>
          </div>

          <!-- Name + username -->
          <div class="member-info">
            <div class="member-riot" v-if="m.riotName">
              {{ m.riotName }}#{{ m.riotTag }}
            </div>
            <div
              class="member-username"
              v-if="m.telegramUsername"
            >
              @{{ m.telegramUsername }}
            </div>
            <div class="member-username" v-if="!m.riotName && !m.telegramUsername">
              unknown
            </div>
          </div>
        </button>

        <!-- Rank icons: current + peak -->
        <div class="member-rank">
          <img
            v-if="m.currentTierId !== null"
            :src="`/ranks/${m.currentTierId}.png`"
            :alt="m.currentTierName ?? ''"
            :title="`Текущий: ${m.currentTierName ?? '—'}`"
            class="rank-icon rank-icon--current"
          />
          <span v-else class="pill rank-empty">—</span>

          <img
            v-if="m.peakTierId !== null && m.peakTierId !== m.currentTierId"
            :src="`/ranks/${m.peakTierId}.png`"
            :alt="m.peakTierName ?? ''"
            :title="`Пиковый: ${m.peakTierName ?? '—'}${m.peakSeasonShort ? ` (${m.peakSeasonShort})` : ''}`"
            class="rank-icon rank-icon--peak"
          />
        </div>

        <!-- Action buttons -->
        <div class="member-actions">
          <button
            v-if="m.telegramUsername"
            type="button"
            class="action-btn action-tg"
            aria-label="Открыть чат в Telegram"
            @click="openTgChat(m.telegramUsername!, $event)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <transition name="toast-fade">
      <div v-if="toastMsg" class="toast-bubble">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiFetch } from '../lib/api.ts';
import { MembersResponseSchema, type Member } from '../../shared/schemas/members.ts';

const members = ref<Member[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const toastMsg = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(async () => {
  try {
    members.value = await apiFetch('/api/members', MembersResponseSchema);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

function showToast(msg: string) {
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastMsg.value = msg;
  toastTimer = setTimeout(() => {
    toastMsg.value = null;
    toastTimer = null;
  }, 1500);
}

function hapticImpact(style: 'light' | 'medium') {
  type WebApp = { HapticFeedback?: { impactOccurred?: (s: string) => void } };
  const wa = (window as Window & { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  wa?.HapticFeedback?.impactOccurred?.(style);
}

async function copyRiotId(m: Member, evt: Event) {
  evt.stopPropagation();
  if (!m.riotName || !m.riotTag) return;
  const id = `${m.riotName}#${m.riotTag}`;
  try {
    await navigator.clipboard.writeText(id);
    showToast(`${id} скопирован`);
    hapticImpact('light');
  } catch {
    showToast('Не удалось скопировать');
  }
}

function openTgChat(username: string, evt: Event) {
  evt.stopPropagation();
  const url = `https://t.me/${username}`;
  type WebApp = { openTelegramLink?: (url: string) => void };
  const wa = (window as Window & { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
  if (wa?.openTelegramLink) {
    wa.openTelegramLink(url);
  } else {
    window.open(url, '_blank');
  }
  hapticImpact('light');
}

function onCardPointerMove(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  const x = (event.offsetX / target.clientWidth) * 100;
  const y = (event.offsetY / target.clientHeight) * 100;
  target.style.setProperty('--mouse-x', `${x}%`);
  target.style.setProperty('--mouse-y', `${y}%`);
}

function valorantCardUrl(id: string | null): string | null {
  if (!id) return null;
  return `https://media.valorant-api.com/playercards/${id}/smallart.png`;
}

function avatarInitial(m: Member): string {
  if (m.riotName) return m.riotName.charAt(0).toUpperCase();
  if (m.telegramUsername) return m.telegramUsername.charAt(0).toUpperCase();
  return '?';
}
</script>

<style scoped>
.state-center {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

.members-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Override card padding for list items — more compact */
.member-card {
  --mouse-x: 50%;
  --mouse-y: 50%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 14px;
  text-decoration: none;
}

/* Cursor-tracking spotlight overlay — sits behind card content */
.member-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    circle 220px at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(115, 131, 255, 0.18),
    transparent 60%
  );
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
  z-index: 0;
}

@media (hover: hover) {
  .member-card:hover::before { opacity: 1; }
}

/* Left-half copy trigger: avatar + name */
.member-copy-trigger {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: 12px;
  position: relative;
  z-index: 1;
}
.member-copy-trigger:disabled { cursor: default; }

/* Avatar */
.member-avatar {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: visible;
  border: 1px solid var(--glass-border-strong);
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 9px;
}

.avatar-img--card {
  object-fit: cover;
}

.tg-avatar-overlay {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--bg, #0e0e15);
  object-fit: cover;
}

.tg-avatar-overlay--placeholder {
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(115, 131, 255, 0.6), rgba(177, 94, 255, 0.5));
  color: var(--fg);
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}

.avatar-placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, rgba(115, 131, 255, 0.3), rgba(177, 94, 255, 0.25));
  color: var(--fg);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.avatar-placeholder--unlinked {
  background: linear-gradient(135deg, rgba(115, 131, 255, 0.15), rgba(177, 94, 255, 0.10));
  color: var(--muted);
  font-size: 32px;
  font-weight: 400;
}

/* Name area */
.member-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.member-riot {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg);
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.member-username {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Rank icons (current + peak) */
.member-rank {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.rank-icon {
  display: block;
  width: 38px;
  height: 38px;
  object-fit: contain;
}

.rank-icon--peak {
  width: 26px;
  height: 26px;
  opacity: 0.55;
  filter: saturate(0.8);
}

.rank-empty {
  font-size: 13px;
  color: var(--muted);
}

/* Action buttons */
.member-actions {
  position: relative;
  z-index: 1;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}

.action-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  transition: background 0.15s ease, color 0.15s ease;
}

.action-btn:hover,
.action-btn:active {
  background: var(--glass-bg-hover);
  color: var(--fg);
}

/* Toast */
.toast-bubble {
  position: fixed;
  left: 50%;
  top: max(28px, env(safe-area-inset-top, 28px));
  transform: translateX(-50%);
  padding: 10px 18px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-radius: 999px;
  color: var(--fg);
  font-size: 13px;
  z-index: 100;
  box-shadow: var(--shadow-deep);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.2s ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}

/* Reduced-motion: disable spotlight transition */
@media (prefers-reduced-motion: reduce) {
  .member-card::before { transition: none; }
}
</style>
