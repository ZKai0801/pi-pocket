<script setup lang="ts">
/**
 * 主机状态: the phone's answer to "what is this machine doing right now".
 *
 * It is a pushed view of the 连接 tab, not an overlay: Android Back pops it the
 * same way it pops the editor, which is why it takes no scrim and no close
 * handler of its own beyond emitting 返回.
 *
 * The layout follows the numbers' own priority — CPU, then memory, then per-card
 * GPU, then the processes — because the question this screen exists for is
 * "is the box busy, and is it my GPU that is busy". Curves, per-core bars and a
 * sortable process table are deliberately absent: the phone is not htop, and
 * every figure here costs one exec round trip to produce.
 */
import { computed } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import {
  formatKibibytes,
  formatLoad,
  formatMegabytes,
  formatPercent,
  formatUptime,
  HOST_METRICS_PROCESS_LIMIT,
  type HostGpuSample,
} from '../../host/hostMetrics';
import { useHostMetricsStore } from '../../stores/hostMetrics';
import { t } from '../../i18n';

const emit = defineEmits<{ close: [] }>();

const metrics = useHostMetricsStore();

const snapshot = computed(() => metrics.snapshot);
const cpu = computed(() => snapshot.value?.cpu ?? null);
const memory = computed(() => snapshot.value?.memory ?? null);
const gpus = computed(() => snapshot.value?.gpus ?? []);
const processes = computed(() => snapshot.value?.processes ?? []);

/** Bar width, with a null reading drawn as an empty bar rather than a full one. */
function widthOf(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '0%';
  return `${Math.min(100, Math.max(0, percent))}%`;
}

function barTone(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 90) return 'host-bar__fill--hot';
  if (percent >= 70) return 'host-bar__fill--warm';
  return '';
}

/**
 * A card that reports utilisation but no video memory (an AMD GPU through
 * sysfs) still gets its figures row: an unreadable value draws as a dash there
 * rather than vanishing, so "the host would not say" stays distinguishable from
 * "the host has no card".
 */
function gpuMemoryLabel(gpu: HostGpuSample): string {
  return `${formatMegabytes(gpu.memoryUsedMb)} / ${formatMegabytes(gpu.memoryTotalMb)}`;
}

const failureCopy = computed(() => {
  switch (metrics.error) {
    case 'no-connection':
      return t('host.noConnection');
    case 'transport':
      return t('host.failedTransport');
    case 'unreadable':
      return t('host.failedUnreadable');
    default:
      return '';
  }
});

/** Numbers are old once a read failed: say when they were taken, not that they are wrong. */
const capturedLabel = computed(() => {
  const at = snapshot.value?.capturedAt;
  if (at === undefined) return '';
  return t('host.updatedAt', { time: new Date(at).toLocaleTimeString() });
});

/** The three load averages, labelled — a bare `0.52 0.38 0.21` is not copy. */
const loadCopy = computed(() => {
  const value = cpu.value;
  if (!value) return '';
  return `${t('host.load')} ${formatLoad(value.load1)} · ${formatLoad(value.load5)} · ${formatLoad(value.load15)}`;
});

function refresh(): void {
  void metrics.refresh();
}
</script>

<template>
  <main class="screen-content host-screen" aria-labelledby="host-screen-title" data-testid="host-status-screen">
    <header class="host-screen__bar phone-bar">
      <button
        type="button"
        class="phone-icon-btn host-screen__back"
        :aria-label="t('host.close')"
        data-testid="host-status-back"
        @click="emit('close')"
      >
        <AppIcon name="arrow-left" />
      </button>
      <h1 id="host-screen-title" class="host-screen__title">{{ t('host.title') }}</h1>
      <button
        type="button"
        class="phone-icon-btn phone-icon-btn--accent host-screen__refresh"
        :aria-label="t('host.refresh')"
        :disabled="metrics.loading"
        data-testid="host-status-refresh"
        @click="refresh"
      >
        <AppIcon name="rotate-ccw" />
      </button>
    </header>

    <p v-if="metrics.loading && snapshot === null" class="host-screen__status">{{ t('host.refreshing') }}</p>
    <p v-else-if="snapshot === null && failureCopy" class="host-screen__error" role="alert" data-testid="host-status-error">
      {{ failureCopy }}
    </p>

    <template v-if="snapshot">
      <p v-if="failureCopy" class="host-screen__notice" data-testid="host-status-stale" role="status">
        {{ failureCopy }} {{ capturedLabel }}
      </p>
      <p v-else-if="capturedLabel" class="host-screen__time">{{ capturedLabel }}</p>
      <p v-if="!snapshot.procReadable" class="host-screen__notice">{{ t('host.partial') }}</p>

      <section class="panel host-card">
        <h2 class="host-card__title">{{ t('host.cpu') }}</h2>
        <div class="host-bar" role="img" :aria-label="`${t('host.cpu')} ${formatPercent(cpu?.usedPercent ?? null)}`">
          <div
            class="host-bar__fill"
            :class="barTone(cpu?.usedPercent ?? null)"
            :style="{ width: widthOf(cpu?.usedPercent ?? null) }"
          />
        </div>
        <p class="host-card__figures">
          <strong class="host-card__percent">{{ formatPercent(cpu?.usedPercent ?? null) }}</strong>
          <span class="host-card__sub">{{ loadCopy }}</span>
        </p>
        <dl class="host-card__grid">
          <div>
            <dt>{{ t('host.coresLabel') }}</dt>
            <dd>{{ cpu?.coreCount !== null && cpu?.coreCount !== undefined ? cpu.coreCount : '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('host.uptime') }}</dt>
            <dd>{{ formatUptime(snapshot.uptimeSeconds) }}</dd>
          </div>
        </dl>
      </section>

      <section class="panel host-card">
        <h2 class="host-card__title">{{ t('host.memory') }}</h2>
        <div class="host-bar" role="img" :aria-label="`${t('host.memory')} ${formatPercent(memory?.usedPercent ?? null)}`">
          <div
            class="host-bar__fill"
            :class="barTone(memory?.usedPercent ?? null)"
            :style="{ width: widthOf(memory?.usedPercent ?? null) }"
          />
        </div>
        <p class="host-card__figures">
          <strong class="host-card__percent">{{ formatPercent(memory?.usedPercent ?? null) }}</strong>
          <span class="host-card__sub">
            {{ t('host.memoryUsed', { used: formatKibibytes(memory?.usedKb ?? null), total: formatKibibytes(memory?.totalKb ?? null) }) }}
          </span>
        </p>
        <dl v-if="snapshot.memory.swapTotalKb > 0" class="host-card__grid">
          <div>
            <dt>{{ t('host.swap') }}</dt>
            <dd>{{ formatKibibytes(snapshot.memory.swapUsedKb) }} / {{ formatKibibytes(snapshot.memory.swapTotalKb) }}</dd>
          </div>
        </dl>
      </section>

      <section class="panel host-card" data-testid="host-gpu-section">
        <h2 class="host-card__title">{{ t('host.gpu') }}</h2>
        <p v-if="gpus.length === 0" class="host-card__empty">{{ t('host.noGpu') }}</p>
        <div v-for="(gpu, index) in gpus" :key="`${gpu.vendor}-${index}`" class="host-gpu">
          <p class="host-gpu__name">{{ gpu.name }}</p>
          <div class="host-bar" role="img" :aria-label="`${gpu.name} ${formatPercent(gpu.utilPercent)}`">
            <div
              class="host-bar__fill"
              :class="barTone(gpu.utilPercent)"
              :style="{ width: widthOf(gpu.utilPercent) }"
            />
          </div>
          <dl class="host-gpu__figures">
            <div><dt>{{ t('host.utilisation') }}</dt><dd>{{ formatPercent(gpu.utilPercent) }}</dd></div>
            <div><dt>{{ t('host.videoMemory') }}</dt><dd>{{ gpuMemoryLabel(gpu) }}</dd></div>
            <div v-if="gpu.temperatureC !== null"><dt>{{ t('host.temperature') }}</dt><dd>{{ Math.round(gpu.temperatureC) }} °C</dd></div>
            <div v-if="gpu.powerDrawW !== null"><dt>{{ t('host.power') }}</dt><dd>{{ gpu.powerDrawW.toFixed(1) }} W</dd></div>
          </dl>
        </div>
      </section>

      <section class="panel host-card">
        <h2 class="host-card__title">{{ t('host.processes') }}</h2>
        <p class="host-card__hint">{{ t('host.processesHint', { count: HOST_METRICS_PROCESS_LIMIT }) }}</p>
        <p v-if="processes.length === 0" class="host-card__empty">{{ t('host.noProcesses') }}</p>
        <table v-else class="host-processes">
          <thead>
            <tr>
              <th scope="col">{{ t('host.column.process') }}</th>
              <th scope="col" class="host-processes__num">{{ t('host.column.cpu') }}</th>
              <th scope="col" class="host-processes__num">{{ t('host.column.mem') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in processes" :key="row.pid">
              <td class="host-processes__name">
                <span class="host-processes__command">{{ row.command }}</span>
                <span class="host-processes__meta">{{ row.pid }} · {{ row.user }}</span>
              </td>
              <td class="host-processes__num">{{ row.cpuPercent.toFixed(1) }}</td>
              <td class="host-processes__num">{{ row.memPercent.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </main>
</template>

<style scoped>
.host-screen {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.host-screen__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.host-screen__title {
  flex: 1 1 auto;
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.host-screen__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}

.host-screen__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
}

.host-screen__notice,
.host-screen__time {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-100);
  line-height: 1.45;
}

.host-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
}

.host-card__title {
  margin: 0;
  color: var(--fg-secondary);
  font: var(--fw-semibold) var(--fs-200) / 1 var(--font-ui);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.host-card__hint {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-100);
}

.host-card__empty {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}

.host-card__figures {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0;
}

.host-card__percent {
  color: var(--fg);
  font: var(--fw-semibold) var(--fs-500) / 1 var(--font-mono);
}

.host-card__sub {
  color: var(--fg-secondary);
  font: var(--fs-200) / 1.3 var(--font-mono);
}

/* A bar is the shape of the number, not a decoration: the figure next to it is
   the authoritative reading, and a null draws empty. */
.host-bar {
  display: flex;
  height: 8px;
  width: 100%;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  overflow: hidden;
}

.host-bar__fill {
  border-radius: var(--r-sm);
  background: var(--accent);
  transition: width var(--dur-normal) var(--ease-out);
}

.host-bar__fill--warm {
  background: var(--warning);
}

.host-bar__fill--hot {
  background: var(--error);
}

.host-card__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-1) var(--sp-3);
  margin: 0;
}

.host-card__grid div {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
}

.host-card__grid dt,
.host-gpu__figures dt {
  color: var(--fg-muted);
  font-size: var(--fs-100);
}

.host-card__grid dd,
.host-gpu__figures dd {
  margin: 0;
  color: var(--fg);
  font: var(--fs-200) var(--font-mono);
}

.host-gpu {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-top: 1px solid var(--border-soft);
  padding-top: var(--sp-2);
}

.host-gpu__name {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}

.host-gpu__figures {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-1) var(--sp-3);
  margin: 0;
}

.host-gpu__figures div {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
}

.host-processes {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-200);
}

.host-processes th {
  color: var(--fg-muted);
  font-weight: var(--fw-regular);
  text-align: left;
}

.host-processes th,
.host-processes td {
  padding: var(--sp-1) 0;
  border-bottom: 1px solid var(--border-soft);
}

.host-processes tr:last-child td {
  border-bottom: 0;
}

.host-processes__num {
  width: 15%;
  text-align: right !important;
  color: var(--fg);
  font-family: var(--font-mono);
}

.host-processes__name {
  min-width: 0;
}

.host-processes__command {
  display: block;
  overflow: hidden;
  color: var(--fg);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-processes__meta {
  display: block;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-100);
}
</style>
