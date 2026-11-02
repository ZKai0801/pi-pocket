<script setup lang="ts">
/**
 * The 连接 row's host-load badge: the one place the phone shows what the machine
 * is doing without the user asking.
 *
 * It is presentational on purpose — the numbers arrive as props and the tap is
 * an emit — because the live host's identity, the poll and the failure state all
 * belong to the store, and a component that reaches for them itself cannot be
 * shown the three cases that matter: a reading, no reading yet, and a reading
 * that is old.
 *
 * A null is drawn as a dash, never as 0%. `procReadable: false` on a BSD host and
 * a sample that has not landed yet are both "we do not know", and inventing a
 * number would be the worse bug of the two.
 */
import { computed } from 'vue';
import { formatLoad, formatPercent } from '../../host/hostMetrics';
import { t } from '../../i18n';

const props = defineProps<{
  cpuPercent: number | null;
  load1: number | null;
  /** A sample is in flight and there is nothing on screen yet. */
  pending?: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const unknown = computed(() => props.cpuPercent === null && props.load1 === null);

const label = computed(() => (
  unknown.value
    ? t('host.badgeUnknown')
    : t('host.badgeAria', { cpu: formatPercent(props.cpuPercent), load: formatLoad(props.load1) })
));
</script>

<template>
  <button
    type="button"
    class="host-badge"
    :class="{ 'host-badge--unknown': unknown }"
    :aria-label="label"
    :title="label"
    data-testid="host-load-badge"
    @click="emit('open')"
  >
    <span class="host-badge__cpu">{{ unknown ? '—' : formatPercent(cpuPercent) }}</span>
    <span class="host-badge__load">{{ unknown ? '' : formatLoad(load1) }}</span>
    <span v-if="pending && unknown" class="host-badge__state" aria-hidden="true">…</span>
  </button>
</template>

<style scoped>
.host-badge {
  display: flex;
  min-width: 56px;
  min-height: 48px;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: 0;
  background: transparent;
  padding: 0 var(--sp-2);
  color: var(--fg-secondary);
  font: var(--fs-200) / 1.2 var(--font-mono);
}

.host-badge:active {
  background: var(--state-hover);
}

.host-badge:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.host-badge__cpu {
  color: var(--fg);
  font-weight: var(--fw-semibold);
}

.host-badge__load {
  color: var(--fg-muted);
}

.host-badge--unknown .host-badge__cpu {
  color: var(--fg-muted);
}

/* The "sampling" mark sits beside the dash it explains, so it stays quieter
   than either. */
.host-badge__state {
  color: var(--fg-muted);
  font-size: var(--fs-100);
}
</style>
