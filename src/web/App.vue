<template><RouterView /></template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { apiFetch } from './lib/api.ts';
import { MeResponseSchema } from '../shared/schemas/me.ts';

const router = useRouter();

onMounted(async () => {
  try {
    const me = await apiFetch('/api/me', MeResponseSchema);
    if (!me.onboarded && router.currentRoute.value.name !== 'onboard') {
      await router.replace({ name: 'onboard' });
    }
  } catch (err) {
    console.warn('Failed to check /api/me:', err);
  }
});
</script>
