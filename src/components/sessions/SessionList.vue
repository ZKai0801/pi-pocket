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
 *
 * Long-pressing a row turns the list into a tick list (see `SessionRow`): the
 * header becomes a selection bar with 全选 / 删除 / 完成, and 删除 opens a
 * confirm dialog first. That confirmation is the point — deleting removes the
 * conversation's session file on the host, and there is no undo, so the count
 * and the consequence are stated before anything goes. A conversation with a
 * turn still running is named but skipped: pi is still writing to its file.
 */
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { projectBasename, useSessionsStore } from '../../stores/sessions';
import { useProjectsStore } from '../../stores/projects';
import { t } from '../../i18n';
import SessionRow from './SessionRow.vue';

const store = useSessionsStore();
const projects = useProjectsStore();

/** The confirmation is open: the user has asked to delete, not yet confirmed. */
const confirming = ref(false);

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

/**
 * The paths the tick list is acting on: whichever of the two lists is on
 * screen right now (a project's conversations, or the recently opened ones).
 */
const visiblePaths = computed<string[]>(() => {
  const rows = projects.selected === null ? store.recents : store.sessions;
  return rows.map((row) => row.path);
});

/** Rows that can be deleted: everything on screen whose turn has finished. */
const deletablePaths = computed<string[]>(() =>
  visiblePaths.value.filter((path) => !store.running.includes(path)));

const allSelected = computed(() => (
  deletablePaths.value.length > 0
  && deletablePaths.value.every((path) => store.selected.includes(path))
));

/** How many of the ticks name a conversation pi is still working in. */
const runningSelected = computed(() =>
  store.selected.filter((path) => store.running.includes(path)).length);

const canDelete = computed(() => store.selected.length > 0 && !store.deleting);

function openSession(path: string): void {
  void store.openSession(path);
}

/** The row's conversation has a turn running — possibly in the background. */
function isRunning(path: string): boolean {
  return store.running.includes(path);
}

function isSelected(path: string): boolean {
  return store.selected.includes(path);
}

function newConversation(): void {
  const project = store.lastProject;
  if (project === null) return;
  store.newConversation(project);
}

function retry(): void {
  void store.refresh();
}

function finishSelection(): void {
  confirming.value = false;
  store.cancelSelection();
}

/**
 * Delete the ticked conversations. The dialog stays open on a failure — the
 * count it named is still on the host, and the error is written into it — and
 * closes the moment the sweep is done with everything it was asked to remove.
 */
async function confirmDelete(): Promise<void> {
  await store.deleteSelected();
  if (store.deleteError === null || store.selected.length === 0) confirming.value = false;
}
</script>

<template>
  <section class="sessions">
    <header class="sessions__bar">
      <h1 v-if="store.selecting" class="sessions__title" data-testid="sessions-select-title">
        {{ t('sessions.selectTitle', { count: store.selected.length }) }}
      </h1>
      <h1 v-else class="sessions__title">{{ t('sessions.title') }}</h1>

      <div class="sessions__actions">
        <template v-if="store.selecting">
          <button
            type="button"
            class="sessions__action"
            data-testid="sessions-select-all"
            @click="store.setAllSelected(!allSelected, visiblePaths)"
          >
            {{ allSelected ? t('sessions.deselectAll') : t('sessions.selectAll') }}
          </button>
          <button
            type="button"
            class="sessions__action sessions__action--danger"
            data-testid="sessions-delete"
            :disabled="!canDelete"
            @click="confirming = true"
          >
            <AppIcon name="trash-2" class="sessions__action-glyph" />
            {{ t('sessions.deleteAction') }}
          </button>
          <button
            type="button"
            class="sessions__action sessions__action--done"
            data-testid="sessions-select-done"
            @click="finishSelection"
          >
            {{ t('sessions.doneAction') }}
          </button>
        </template>

        <button
          v-else
          type="button"
          class="sessions__add"
          :aria-label="t('sessions.new')"
          :disabled="store.lastProject === null"
          @click="newConversation"
        >
          <AppIcon name="plus" />
        </button>
      </div>
    </header>

    <!-- The affordance, quiet and only while the list has something to
         long-press: a hint with no rows behind it promises nothing. -->
    <p v-if="!store.selecting && visiblePaths.length > 0" class="sessions__hint">
      {{ t('sessions.selectHint') }}
    </p>

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
              :selecting="store.selecting"
              :selected="isSelected(entry.path)"
              @open="openSession"
              @long-press="store.startSelection"
              @toggle="store.toggleSelected"
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
              :selecting="store.selecting"
              :selected="isSelected(session.path)"
              @open="openSession"
              @long-press="store.startSelection"
              @toggle="store.toggleSelected"
            />
          </ul>

          <div v-else class="sessions__empty">
            <p class="sessions__empty-text">{{ emptyText }}</p>
          </div>
        </template>
      </template>
    </div>

    <!-- The irreversible step, taken only here: the dialog names what goes
         and where it goes from, so confirming is a deliberate act. -->
    <div
      v-if="confirming"
      class="sessions__scrim"
      data-testid="sessions-delete-scrim"
      @click.self="confirming = false"
    >
      <div
        class="sessions__confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="t('sessions.deleteConfirmTitle', { count: store.selected.length })"
        data-testid="sessions-delete-confirm"
      >
        <p class="sessions__confirm-title">
          {{ t('sessions.deleteConfirmTitle', { count: store.selected.length }) }}
        </p>
        <p class="sessions__confirm-body">{{ t('sessions.deleteConfirmBody') }}</p>
        <p v-if="runningSelected > 0" class="sessions__confirm-note">
          {{ t('sessions.deleteConfirmRunning', { count: runningSelected }) }}
        </p>
        <p v-if="store.deleteError" class="sessions__confirm-error" role="alert">
          {{ store.deleteError }}
        </p>
        <div class="sessions__confirm-actions">
          <button
            type="button"
            class="sessions__confirm-cancel"
            data-testid="sessions-delete-cancel"
            @click="confirming = false"
          >
            {{ t('sessions.cancel') }}
          </button>
          <button
            type="button"
            class="sessions__confirm-ok"
            data-testid="sessions-delete-confirm-ok"
            :disabled="store.deleting"
            @click="void confirmDelete()"
          >
            {{ store.deleting ? t('sessions.deleting') : t('sessions.deleteAction') }}
          </button>
        </div>
      </div>
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

.sessions__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sp-1);
}

.sessions__title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.sessions__hint {
  margin: calc(-1 * var(--sp-2)) 0 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
}

/* Text actions, not icon buttons: three of them sit where one + used to, and
   words say what each one does better than a third glyph would. */
.sessions__action {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  gap: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-3);
  color: var(--fg);
  font: var(--fw-medium) var(--fs-200) / 1 var(--font-ui);
}

.sessions__action:disabled {
  opacity: var(--disabled-opacity);
}

.sessions__action--danger {
  border-color: var(--error);
  color: var(--error);
}

.sessions__action--done {
  border-color: var(--border-strong);
  color: var(--accent);
}

.sessions__action-glyph {
  width: 14px;
  height: 14px;
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

.sessions__scrim {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  padding: var(--sp-4);
}

.sessions__confirm {
  display: flex;
  width: 100%;
  max-width: 360px;
  flex-direction: column;
  gap: var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-4);
}

.sessions__confirm-title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
}

.sessions__confirm-body {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.5;
}

/* Which of the ticks cannot go: a turn is still running in them. */
.sessions__confirm-note {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.sessions__confirm-error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.sessions__confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}

.sessions__confirm-cancel,
.sessions__confirm-ok {
  min-height: 48px;
  border-radius: var(--r-md);
  padding: 0 var(--sp-4);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.sessions__confirm-cancel {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--fg);
}

/* The one destructive control on the tab: filled with the error colour, and
   `--on-accent` as its text — the shared set's darkest ink, which clears
   4.5:1 on it. */
.sessions__confirm-ok {
  border: 1px solid var(--error);
  background: var(--error);
  color: var(--on-accent);
}

.sessions__confirm-ok:disabled {
  opacity: var(--disabled-opacity);
}

.sessions__confirm-cancel:focus-visible,
.sessions__confirm-ok:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
