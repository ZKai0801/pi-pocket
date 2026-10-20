<script setup lang="ts">
// Feather 4.29 `lock` (MIT), drawn under AppIcon's contract (24x24 viewBox,
// currentColor stroke, width 2, round caps/joins). The shared AppIcon registry
// has no lock mark yet; this Android-only copy follows KeyIcon.vue's precedent.
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
</template>
