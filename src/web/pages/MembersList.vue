<template>
  <div class="container">
    <div class="members-header">
      <router-link to="/settings" class="settings-gear" aria-label="Настройки">⚙</router-link>
    </div>

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
        role="button"
        tabindex="0"
        @click="openProfile(m.telegramId)"
        @keydown.enter="openProfile(m.telegramId)"
        @keydown.space.prevent="openProfile(m.telegramId)"
      >
        <!-- Avatar -->
        <div class="member-avatar">
          <img
            v-if="m.telegramAvatarUrl"
            :src="m.telegramAvatarUrl"
            :alt="m.telegramUsername ?? ''"
            class="avatar-img"
          />
          <div v-else class="avatar-placeholder">
            {{ avatarInitial(m) }}
          </div>
        </div>

        <!-- Name + tag -->
        <div class="member-info">
          <div class="member-name">
            <span v-if="m.riotName">{{ m.riotName }}#{{ m.riotTag }}</span>
            <span v-else>@{{ m.telegramUsername ?? 'unknown' }}</span>
            <span v-if="m.riotName && m.telegramUsername" class="text-muted member-username">@{{ m.telegramUsername }}</span>
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
      </div>
    </div>
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

function avatarInitial(m: Member): string {
  if (m.riotName) return m.riotName.charAt(0).toUpperCase();
  if (m.telegramUsername) return m.telegramUsername.charAt(0).toUpperCase();
  return '?';
}
</script>

<style scoped>
.members-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}

.settings-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  color: var(--muted);
  font-size: 16px;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.settings-gear:hover {
  background: var(--glass-bg-hover);
  color: var(--fg);
}

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
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 14px;
  cursor: pointer;
  transition: background 0.15s ease;
  text-decoration: none;
}

.member-card:hover {
  background: var(--glass-bg-hover);
}

/* Avatar */
.member-avatar {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--glass-border-strong);
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  flex: 1;
  min-width: 0;
}

.member-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
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
}

/* Rank icons (current + peak) */
.member-rank {
  flex-shrink: 0;
  margin-left: auto;
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
</style>
