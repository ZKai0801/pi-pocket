<script setup lang="ts">
/**
 * Projects (tab 2, spec §8.5): the Pi projects discovered on the live host.
 * A search box filters by name or path, pull-to-refresh re-runs discovery,
 * the + opens the directory browser for a project the agent has not touched
 * yet (spec §9.1), and tapping a row selects it for the 会话 tab. With no
 * live connection the list is a connect-first hint, not an empty list
 * (spec §8.4).
 */
import { computed, onMounted, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { useConnectionsStore } from '../../stores/connections';
import { useProjectsStore } from '../../stores/projects';
import { t } from '../../i18n';

const store = useProjectsStore();
const connections = useConnectionsStore();

const connected = computed(() => connections.status === 'connected');

onMounted(() => { void store.discover(); });

const piDir = ref('');
const activePiDir = computed(() => {
  const name = connections.activeName;
  if (name === null) return '';
  return connections.hosts.find((host) => host.name === name)?.piSessionsDir ?? '';
});
watch(activePiDir, (value) => { piDir.value = value; }, { immediate: true });

function savePiDir(): void {
  const name = connections.activeName;
  if (name === null) return;
  void store.savePiSessionsDir(name, piDir.value);
}

// Pull-to-refresh on the project list: a resisted stretch from the top edge
// that only re-runs discovery once the drag clears a deliberate threshold.
// Values are CSS px of visual stretch - with PULL_RESISTANCE the finger has to
// travel PULL_TRIGGER_PX / PULL_RESISTANCE (200 px) before releasing refreshes.
const scroller = ref<HTMLElement | null>(null);
const pullDistance = ref(0);
const refreshing = ref(false);
let touchStartY = 0;
let startedAtTop = false;
let touching = false;

const PULL_MAX_PX = 96;
const PULL_RESISTANCE = 0.4;
const PULL_TRIGGER_PX = 80;

const showPull = computed(() => pullDistance.value > 0 || refreshing.value);
const pullHeight = computed(() => (refreshing.value ? 24 : pullDistance.value));
const pullArmed = computed(() => !refreshing.value && pullDistance.value >= PULL_TRIGGER_PX);

function onPullStart(event: TouchEvent): void {
  const element = scroller.value;
  const y = event.touches[0]?.clientY;
  if (!element || y === undefined || refreshing.value) return;
  touchStartY = y;
  startedAtTop = element.scrollTop <= 0;
  touching = true;
}

function onPullMove(event: TouchEvent): void {
  if (!touching || !startedAtTop) return;
  const element = scroller.value;
  const y = event.touches[0]?.clientY;
  if (!element || y === undefined) return;
  if (element.scrollTop > 0) {
    // The list scrolled instead of stretching - drop this gesture.
    touching = false;
    pullDistance.value = 0;
    return;
  }
  const delta = y - touchStartY;
  // Resisted stretch, capped: the list drags at a fraction of the finger travel.
  pullDistance.value = delta > 0 ? Math.min(PULL_MAX_PX, delta * PULL_RESISTANCE) : 0;
}

function onPullEnd(): void {
  if (!touching) return;
  touching = false;
  const release = pullDistance.value >= PULL_TRIGGER_PX;
  pullDistance.value = 0;
  if (release) void refresh();
}

async function refresh(): Promise<void> {
  if (refreshing.value || !connected.value) return;
  refreshing.value = true;
  try {
    await store.discover();
  } finally {
    refreshing.value = false;
  }
}

function selectProject(path: string): void {
  store.select(path);
}

function enterDirectory(path: string): void {
  void store.browseEnter(path);
}

function addCurrentDirectory(): void {
  const cwd = store.browse.cwd;
  if (cwd !== null) store.addProject(cwd);
}
</script>

<template>
  <section class="projects">
    <header class="projects__bar">
      <h1 class="projects__title">{{ t('projects.title') }}</h1>
      <div class="projects__actions">
        <button type="button" class="projects__add" :aria-label="t('projects.add')" @click="void store.openBrowse()">
          <AppIcon name="plus" />
        </button>
      </div>
    </header>

    <div class="projects__search">
      <AppIcon name="search" class="projects__search-icon" />
      <input
        v-model="store.query"
        type="search"
        class="projects__search-input"
        :placeholder="t('projects.search')"
        :aria-label="t('projects.search')"
      />
    </div>

    <div
      class="projects__scroller"
      ref="scroller"
      @touchstart.passive="onPullStart"
      @touchmove.passive="onPullMove"
      @touchend="onPullEnd"
    >
      <div v-if="showPull" class="projects__pull" :style="{ height: `${pullHeight}px` }">
        <AppIcon
          :name="refreshing ? 'refresh' : 'chevron-down'"
          class="projects__pull-icon"
          :class="{
            'projects__pull-icon--armed': pullArmed,
            'projects__pull-icon--spinning': refreshing,
          }"
        />
      </div>

      <p v-if="store.state === 'loading'" class="projects__status">{{ t('projects.discovering') }}</p>

      <p v-else-if="!connected" class="projects__status" role="alert">
        {{ t('projects.needConnection') }}
      </p>

      <p v-else-if="store.state === 'error'" class="projects__error" role="alert">{{ store.error }}</p>

      <template v-else>
        <div v-if="store.state === 'no-root'" class="projects__no-root" data-testid="projects-no-root">
          <p class="projects__status">
            {{ t('projects.noRoot') }}
          </p>
          <label class="projects__no-root-field">
            <span class="projects__no-root-label">{{ t('projects.rootLabel') }}</span>
            <input
              v-model="piDir"
              type="text"
              class="projects__no-root-input"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('projects.rootPlaceholder')"
              data-testid="projects-pi-dir-input"
            />
          </label>
          <button
            type="button"
            class="projects__no-root-save"
            data-testid="projects-pi-dir-save"
            @click="savePiDir"
          >
            {{ t('projects.saveAndRescan') }}
          </button>
        </div>

        <ul v-if="(store.state === 'ready' || store.state === 'no-root') && store.filtered.length > 0" class="projects__list">
          <li
            v-for="project in store.filtered"
            :key="project.path"
            class="projects__row"
            :class="{ 'projects__row--selected': store.selected === project.path }"
          >
            <button
              type="button"
              class="projects__item"
              :aria-pressed="store.selected === project.path"
              @click="selectProject(project.path)"
            >
              <AppIcon name="folder" class="projects__folder" />
              <span class="projects__text">
                <span class="projects__name">{{ project.name }}</span>
                <span class="projects__path">{{ project.path }}</span>
              </span>
            </button>
          </li>
        </ul>

        <div v-else class="projects__empty">
          <p class="projects__empty-text">{{ store.query ? t('projects.emptyFiltered') : t('projects.empty') }}</p>
          <button v-if="store.query === ''" type="button" class="projects__empty-button" @click="void store.openBrowse()">
            {{ t('projects.add') }}
          </button>
        </div>
      </template>
    </div>

    <div v-if="store.browse.open" class="projects__sheet-scrim" @click.self="store.closeBrowse()">
      <div class="projects__sheet" role="dialog" :aria-label="t('projects.add')">
        <header class="projects__sheet-bar">
          <h2 class="projects__sheet-title">{{ t('projects.sheetTitle') }}</h2>
          <button type="button" class="projects__sheet-close" :aria-label="t('projects.sheetCloseAria')" @click="store.closeBrowse()">
            <AppIcon name="close" />
          </button>
        </header>

        <p v-if="store.browse.cwd !== null" class="projects__sheet-cwd">{{ store.browse.cwd }}</p>

        <p v-if="store.browse.busy" class="projects__sheet-status">{{ t('projects.loading') }}</p>

        <p v-else-if="store.browse.error" class="projects__sheet-error" role="alert">{{ store.browse.error }}</p>

        <ul v-else class="projects__sheet-list">
          <li v-for="dir in store.browse.dirs ?? []" :key="dir.path" class="projects__sheet-row">
            <button type="button" class="projects__sheet-item" @click="enterDirectory(dir.path)">
              <AppIcon name="folder" class="projects__sheet-folder" />
              <span class="projects__sheet-name">{{ dir.name }}</span>
              <AppIcon name="chevron-right" class="projects__sheet-chevron" />
            </button>
          </li>
          <li v-if="(store.browse.dirs ?? []).length === 0" class="projects__sheet-row">
            <p class="projects__sheet-empty-text">{{ t('projects.emptyDirectory') }}</p>
          </li>
        </ul>

        <footer class="projects__sheet-footer">
          <button
            type="button"
            class="projects__sheet-up"
            :disabled="store.browse.cwd === null || store.browse.cwd === store.browse.root || store.browse.busy"
            @click="void store.browseUp()"
          >
            <AppIcon name="arrow-up" /> {{ t('projects.parentDirectory') }}
          </button>
          <button
            type="button"
            class="projects__sheet-add"
            :disabled="store.browse.cwd === null || store.browse.busy"
            @click="addCurrentDirectory"
          >
            {{ t('projects.addDirectory') }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  box-sizing: border-box;
  height: 100%;
  padding: var(--sp-3);
}

.projects__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.projects__title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.projects__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.projects__add {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--accent);
}

.projects__add:focus-visible,
.projects__item:focus-visible,
.projects__empty-button:focus-visible,
.projects__sheet-close:focus-visible,
.projects__sheet-item:focus-visible,
.projects__sheet-up:focus-visible,
.projects__sheet-add:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.projects__search {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: 0 var(--sp-2);
}

.projects__search:focus-within {
  border-color: var(--accent);
}

.projects__search-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--fg-muted);
}

.projects__search-input {
  width: 100%;
  min-height: 48px;
  border: 0;
  background: transparent;
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  outline: none;
}

.projects__search-input::placeholder {
  color: var(--fg-muted);
}

/* The scroller is the page's one vertical scroll owner. It must NOT be a
   column flex container: `.projects__list` below is `overflow: hidden` (a
   scroll container), so as a flex item its automatic minimum size collapses
   to 0 and it shrinks to the remaining height instead of overflowing — the
   list then clips its own rows and the page never gains a scroll range.
   Block layout keeps every child at its content height. */
.projects__scroller {
  display: block;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}

.projects__pull {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
}

.projects__pull-icon {
  width: 18px;
  height: 18px;
  color: var(--fg-secondary);
  transition: color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}

/* Past the trigger: releasing now refreshes, so say so. */
.projects__pull-icon--armed {
  color: var(--accent);
  transform: rotate(180deg);
}

.projects__pull-icon--spinning {
  animation: projects-spin var(--dur-normal) linear infinite;
}

@keyframes projects-spin {
  to {
    transform: rotate(360deg);
  }
}

.projects__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.45;
}

.projects__no-root {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-3);
}

.projects__no-root-field {
  display: grid;
  gap: var(--sp-1);
}

.projects__no-root-label {
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
}

.projects__no-root-input {
  width: 100%;
  min-width: 0;
  min-height: 48px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  outline: none;
}

.projects__no-root-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.projects__no-root-save {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.projects__no-root-save:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.projects__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.projects__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  overflow: hidden;
}

.projects__row {
  border-bottom: 1px solid var(--border-soft);
}

.projects__row:last-child {
  border-bottom: 0;
}

.projects__row--selected {
  background: var(--accent-soft);
}

.projects__item {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  background: transparent;
  padding: 0 var(--sp-3);
  text-align: left;
}

.projects__item:active {
  background: var(--state-hover);
}

.projects__folder {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--accent);
}

.projects__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.projects__name {
  overflow: hidden;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects__path {
  overflow: hidden;
  color: var(--fg-secondary);
  font: var(--fs-200) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-6) var(--sp-4);
}

.projects__empty-text {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
}

.projects__empty-button {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  padding: 0 var(--sp-5);
  color: var(--on-accent);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.projects__sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: var(--scrim);
}

.projects__sheet {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  display: flex;
  box-sizing: border-box;
  max-height: 70vh;
  flex-direction: column;
  gap: var(--sp-2);
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding: var(--sp-3);
  padding-bottom: calc(var(--android-shell-safe-bottom, var(--safe-area-inset-bottom, 0px)) + var(--sp-3));
}

.projects__sheet-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.projects__sheet-title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
}

.projects__sheet-close {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--fg-secondary);
}

.projects__sheet-close:active {
  background: var(--state-hover);
}

.projects__sheet-cwd {
  margin: 0;
  overflow: hidden;
  color: var(--fg-secondary);
  font: var(--fs-200) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects__sheet-status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}

.projects__sheet-error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.projects__sheet-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}

.projects__sheet-item {
  display: flex;
  width: 100%;
  min-height: 52px;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  border-bottom: 1px solid var(--border-soft);
  background: transparent;
  padding: 0 var(--sp-2);
  text-align: left;
}

.projects__sheet-item:active {
  background: var(--state-hover);
}

.projects__sheet-folder {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--accent);
}

.projects__sheet-name {
  overflow: hidden;
  flex: 1 1 auto;
  color: var(--fg);
  font-size: var(--fs-300);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.projects__sheet-chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--fg-muted);
}

.projects__sheet-empty-text {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  padding: var(--sp-4) var(--sp-2);
}

.projects__sheet-footer {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}

.projects__sheet-up {
  display: inline-flex;
  min-height: 48px;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

.projects__sheet-up:disabled {
  opacity: var(--disabled-opacity);
}

.projects__sheet-add {
  display: inline-flex;
  min-height: 48px;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font: var(--fw-semibold) var(--fs-300) var(--font-ui);
}

.projects__sheet-add:disabled {
  opacity: var(--disabled-opacity);
}
</style>
