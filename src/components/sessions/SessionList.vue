<script setup lang="ts">
/**
 * The 会话 tab's list (spec §8.5): the selected project's Pi conversations,
 * most recent first, each row title + preview + relative time. Tapping a row
 * opens it in the read-only chat; the + opens a draft chat for the selected
 * project, whose first message creates the session. The list loads for the
 * projects tab's selection; with nothing selected it shows the conversations
 * recently opened on this host, so the tab is useful before the 项目 tab has
 * been visited — only a phone with no recents at all sees the hint. The
 * project's remembered rows paint first, so entering a project shows its
 * conversations while the server's listing is still walking the files.
 */
import { computed, onMounted } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { projectBasename, useSessionsStore } from '../../stores/sessions';
import { useProjectsStore } from '../../stores/projects';
import { t } from '../../i18n';
import SessionRow from './SessionRow.vue';

const store = useSessionsStore();
const projects = useProjectsStore();

// The wrapper's watch covers changes, not the value that already held when
// the store was first created — load once if the selection outlived us.
onMounted(() => {
  const selected = projects.selected;
  if (selected !== null && store.lastProject?.path !== selected) {
    void store.load({ path: selected, name: projectBasename(selected) });
  }
  // The recently-opened conversations are this tab's first screen: read them
  // on mount, and the wrapper's host-switch watch reloads them when the host
  // changes.
  void store.loadRecents();
});

const emptyText = computed(() => {
  const project = store.lastProject;
  return project === null ? t('sessions.empty') : t('sessions.emptyForProject', { project: project.name });
});

function openSession(path: string): void {
  void store.openSession(path);
}

/** The row's conversation has a turn running — possibly in the background. */
function isRunning(path: string): boolean {
  return store.running.includes(path);
}

function newConversation(): void {
  const project = store.lastProject;
  if (project === null) return;
  store.newConversation(project);
}

function retry(): void {
  void store.refresh();
}
</script>

<template>
  <section class="sessions">
    <header class="sessions__bar">
      <h1 class="sessions__title">{{ t('sessions.title') }}</h1>
      <button
        type="button"
        class="sessions__add"
        :aria-label="t('sessions.new')"
        :disabled="store.lastProject === null"
        @click="newConversation"
      >
        <AppIcon name="plus" />
      </button>
    </header>

    <div class="sessions__body">
      <!-- Nothing selected: the conversations this phone was last in, painted
           from the local memory of opens so the tab answers without a trip
           through the 项目 tab. A phone with no recents keeps the hint. -->
      <template v-if="projects.selected === null">
        <template v-if="store.recents.length > 0">
          <h2 class="sessions__recent" data-testid="sessions-recent">{{ t('sessions.recent') }}</h2>
          <ul class="sessions__list">
            <SessionRow
              v-for="entry in store.recents"
              :key="entry.path"
              :path="entry.path"
              :title="entry.name ?? entry.id"
              :preview="entry.preview"
              :when-ms="entry.openedAtMs"
              :running="isRunning(entry.path)"
              @open="openSession"
            />
          </ul>
          <p class="sessions__recent-hint">{{ t('sessions.recentHint') }}</p>
        </template>
        <p v-else class="sessions__status">{{ t('sessions.selectProjectFirst') }}</p>
      </template>

      <template v-else>
        <p v-if="store.state === 'loading'" class="sessions__status">{{ t('sessions.loading') }}</p>

        <div v-else-if="store.state === 'error'" class="sessions__failed">
          <p class="sessions__error" role="alert">{{ store.error }}</p>
          <button type="button" class="sessions__retry" @click="retry">
            <AppIcon name="refresh" /> {{ t('sessions.retry') }}
          </button>
        </div>

        <template v-else>
          <!-- The backup line appears only once the sync has finished without
               confirming the rows: while the listing is still in flight the list
               is about to correct itself, so saying so would only shift the rows
               under the user's thumb. -->
          <p
            v-if="store.state === 'ready' && store.stale && !store.refreshing"
            class="sessions__stale"
            data-testid="sessions-stale"
          >
            {{ t('sessions.cachedOnly') }}
          </p>

          <ul v-if="store.sessions.length > 0" class="sessions__list">
            <SessionRow
              v-for="session in store.sessions"
              :key="session.path"
              :path="session.path"
              :title="session.name ?? session.id"
              :preview="session.preview"
              :when-ms="session.updatedAtMs"
              :running="isRunning(session.path)"
              @open="openSession"
            />
          </ul>

          <div v-else class="sessions__empty">
            <p class="sessions__empty-text">{{ emptyText }}</p>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  box-sizing: border-box;
  height: 100%;
  padding: var(--sp-3);
}

.sessions__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.sessions__title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.sessions__add {
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

.sessions__add:disabled {
  opacity: var(--disabled-opacity);
}

.sessions__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.sessions__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.45;
}

.sessions__failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-4);
}

.sessions__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.sessions__retry {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  padding: 0 var(--sp-5);
  color: var(--on-accent);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.sessions__retry:active {
  background: var(--accent-dim);
}

.sessions__retry:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* The backup line: the rows below are usable, the server has not confirmed
   them yet. Muted, never an alert — nothing has failed while it is silent. */
.sessions__stale {
  margin: 0 0 var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.sessions__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  overflow-y: auto;
}

/* The recent list's section label: quieter than the tab title, it only says
   where these rows came from. */
.sessions__recent {
  margin: 0 0 var(--sp-2);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  font-weight: var(--fw-medium);
}

.sessions__recent-hint {
  margin: var(--sp-3) 0 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.sessions__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-6) var(--sp-4);
}

.sessions__empty-text {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
}
</style>
