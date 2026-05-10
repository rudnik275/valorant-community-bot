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
        <!-- Avatar -->
        <div class="member-avatar">
          <!-- Primary: Valorant card if available, else TG avatar fallback -->
          <img
            v-if="m.riotCardId"
            :src="valorantCardUrl(m.riotCardId)"
            :alt="m.riotName ?? ''"
            class="avatar-img avatar-img--card"
          />
          <img
            v-else-if="m.telegramAvatarUrl"
            :src="m.telegramAvatarUrl"
            :alt="m.telegramUsername ?? ''"
            class="avatar-img"
          />
          <div v-else class="avatar-placeholder">{{ avatarInitial(m) }}</div>

          <!-- Corner: TG avatar OR initial-circle, ONLY when primary is the Valorant card -->
          <template v-if="m.riotCardId">
            <img
              v-if="m.telegramAvatarUrl"
              :src="m.telegramAvatarUrl"
              :alt="m.telegramUsername ?? ''"
              class="tg-avatar-overlay"
            />
            <div v-else class="tg-avatar-overlay tg-avatar-overlay--placeholder">
              {{ avatarInitial(m) }}
            </div>
          </template>
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
            v-if="m.riotName"
            type="button"
            class="action-btn action-copy"
            aria-label="Скопировать Riot ID"
            @click="copyRiotId(m, $event)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          <button
            v-if="m.telegramUsername"
            type="button"
            class="action-btn action-tg"
            aria-label="Открыть чат в Telegram"
            @click="openTgChat(m.telegramUsername!, $event)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
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
    showToast(`Скопировано: ${id}`);
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

/* Name area */
.member-info {
  position: relative;
  z-index: 1;
  flex: 1;
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
  bottom: 28px;
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
