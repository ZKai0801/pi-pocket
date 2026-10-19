<script setup lang="ts">
/**
 * The 会话 tab's list (spec §8.5): the selected project's Pi conversations,
 * most recent first, each row title + preview + relative time. Tapping a row
 * opens it in the read-only chat; the + is inert in this version (no new
 * sessions from the phone yet). The list loads for the projects tab's
 * selection; with nothing selected it is a hint, not an empty list.
 */
import { computed, onMounted } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { projectBasename, relativeTime, useSessionsStore } from '../../stores/sessions';
import { useProjectsStore } from '../../stores/projects';

const store = useSessionsStore();
const projects = useProjectsStore();

// The wrapper's watch covers changes, not the value that already held when
// the store was first created — load once if the selection outlived us.
onMounted(() => {
  const selected = projects.selected;
  if (selected !== null && store.lastProject?.path !== selected) {
    void store.load({ path: selected, name: projectBasename(selected) });
  }
});

const emptyText = computed(() => {
  const project = store.lastProject;
  return project === null ? '还没有会话' : `「${project.name}」还没有会话`;
});

function openSession(path: string): void {
  void store.openSession(path);
}

function retry(): void {
  void store.refresh();
}
</script>

<template>
  <section class="sessions">
    <header class="sessions__bar">
      <h1 class="sessions__title">会话</h1>
      <button type="button" class="sessions__add" aria-label="新建会话" disabled>
        <AppIcon name="plus" />
      </button>
    </header>

    <div class="sessions__body">
      <p v-if="projects.selected === null" class="sessions__status">先选择一个项目</p>

      <p v-else-if="store.state === 'loading'" class="sessions__status">正在加载会话…</p>

      <div v-else-if="store.state === 'error'" class="sessions__failed">
        <p class="sessions__error" role="alert">{{ store.error }}</p>
        <button type="button" class="sessions__retry" @click="retry">
          <AppIcon name="refresh" /> 重试
        </button>
      </div>

      <template v-else>
        <ul v-if="store.sessions.length > 0" class="sessions__list">
          <li v-for="session in store.sessions" :key="session.path" class="sessions__row">
            <button type="button" class="sessions__item" @click="openSession(session.path)">
              <AppIcon name="activity" class="sessions__glyph" />
              <span class="sessions__text">
                <span class="sessions__head">
                  <span class="sessions__name">{{ session.name ?? session.id }}</span>
                  <span class="sessions__when">{{ relativeTime(session.updatedAtMs) }}</span>
                </span>
                <span class="sessions__preview">{{ session.preview ?? '没有内容' }}</span>
              </span>
              <AppIcon name="chevron-right" class="sessions__chevron" />
            </button>
          </li>
        </ul>

        <div v-else class="sessions__empty">
          <p class="sessions__empty-text">{{ emptyText }}</p>
        </div>
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

.sessions__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  overflow-y: auto;
}

.sessions__row {
  border-bottom: 1px solid var(--border-soft);
}

.sessions__row:last-child {
  border-bottom: 0;
}

.sessions__item {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  background: transparent;
  padding: var(--sp-3) var(--sp-3);
  text-align: left;
}

.sessions__item:active {
  background: var(--state-hover);
}

.sessions__item:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.sessions__glyph {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--accent);
}

.sessions__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.sessions__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.sessions__name {
  overflow: hidden;
  flex: 1 1 auto;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessions__when {
  flex: 0 0 auto;
  color: var(--fg-muted);
  font-size: var(--fs-200);
}

.sessions__preview {
  display: -webkit-box;
  overflow: hidden;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  word-break: break-word;
}

.sessions__chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--fg-muted);
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
