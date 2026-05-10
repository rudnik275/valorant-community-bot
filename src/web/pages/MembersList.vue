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
        role="button"
        tabindex="0"
        @click="openProfile(m.telegramId)"
        @keydown.enter="openProfile(m.telegramId)"
        @keydown.space.prevent="openProfile(m.telegramId)"
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
  position: relative;
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
