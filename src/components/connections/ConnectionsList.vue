<script setup lang="ts">
/**
 * Connections (tab 1, spec §8.2): the saved-host list. Green/red dot per host,
 * name and `host · user`, a key glyph for key-authed hosts, `…` for edit/delete,
 * `+` in the header to add. Empty state: a big 新增连接 button. Tapping a row
 * connects it (or closes it when it is already the live one); switching hosts
 * closes the current connection first (D8), which the store owns.
 */
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import KeyIcon from '../KeyIcon.vue';
import ConnectionEditor from './ConnectionEditor.vue';
import { useConnectionsStore } from '../../stores/connections';
import type { SavedHost } from '../../platform/android/hostStore';

const props = defineProps<{ editorOpen?: boolean }>();
const emit = defineEmits<{ 'update:editorOpen': [open: boolean] }>();

const store = useConnectionsStore();

const editing = ref<SavedHost | null>(null);
const menuFor = ref<string | null>(null);

const editorOpen = computed(() => props.editorOpen === true);
const connecting = computed(() => store.status === 'connecting');

onMounted(() => store.load());

function isKeyHost(host: SavedHost): boolean {
  return host.auth?.kind !== 'password' && Boolean(host.keyHandleId);
}

function setEditorOpen(open: boolean): void {
  emit('update:editorOpen', open);
}

function openNew(): void {
  editing.value = null;
  menuFor.value = null;
  setEditorOpen(true);
}

function openEdit(host: SavedHost): void {
  editing.value = { ...host };
  menuFor.value = null;
  setEditorOpen(true);
}

function closeEditor(): void {
  setEditorOpen(false);
  editing.value = null;
}

function saveHost(host: SavedHost): void {
  void store.save(host, editing.value?.name ?? null);
  closeEditor();
}

function removeHost(name: string): void {
  menuFor.value = null;
  void store.remove(name);
}

function toggleConnect(host: SavedHost): void {
  if (store.activeName === host.name && store.status === 'connected') void store.disconnect();
  else void store.requestConnect(host.name);
}
</script>

<template>
  <section class="connections">
    <ConnectionEditor
      v-if="editorOpen"
      :host="editing"
      @save="saveHost"
      @cancel="closeEditor"
    />

    <template v-else>
      <header class="connections__bar">
        <h1 class="connections__title">连接</h1>
        <button type="button" class="connections__add" aria-label="新增连接" @click="openNew">
          <AppIcon name="plus" />
        </button>
      </header>

      <p v-if="connecting" class="connections__status">正在连接…</p>
      <p v-if="store.lastError" class="connections__error" role="alert">{{ store.lastError }}</p>

      <div
        v-if="store.pendingSwitch"
        class="connections__confirm"
        role="alertdialog"
        aria-label="切换到其他主机"
        data-testid="connections-switch-confirm"
      >
        <p class="connections__confirm-text">切换到「{{ store.pendingSwitch }}」会断开当前连接。</p>
        <div class="connections__confirm-actions">
          <button
            type="button"
            class="connections__confirm-cancel"
            data-testid="connections-switch-cancel"
            @click="store.cancelSwitch()"
          >
            取消
          </button>
          <button
            type="button"
            class="connections__confirm-ok"
            data-testid="connections-switch-confirm-ok"
            @click="void store.confirmSwitch()"
          >
            切换
          </button>
        </div>
      </div>

      <ul v-if="store.hosts.length > 0" class="connections__list">
        <li v-for="host in store.hosts" :key="host.name" class="connections__row">
          <button
            type="button"
            class="connections__host"
            :aria-pressed="store.activeName === host.name"
            @click="toggleConnect(host)"
          >
            <span
              class="connections__dot"
              :class="store.statusFor(host.name) === 'connected' ? 'connections__dot--on' : 'connections__dot--off'"
              aria-hidden="true"
            />
            <span class="connections__text">
              <span class="connections__name">{{ host.name }}</span>
              <span class="connections__address">{{ host.hostname }} · {{ host.user }}</span>
            </span>
            <KeyIcon v-if="isKeyHost(host)" :size="16" class="connections__key" />
          </button>

          <button
            type="button"
            class="connections__more"
            :aria-label="`${host.name} 的更多操作`"
            :aria-expanded="menuFor === host.name"
            @click="menuFor = menuFor === host.name ? null : host.name"
          >
            …
          </button>

          <div v-if="menuFor === host.name" class="connections__menu" role="menu">
            <button type="button" role="menuitem" class="connections__menu-item" @click="openEdit(host)">
              <AppIcon name="edit-2" /> 编辑
            </button>
            <button type="button" role="menuitem" class="connections__menu-item" @click="removeHost(host.name)">
              <AppIcon name="trash-2" /> 删除
            </button>
          </div>
        </li>
      </ul>

      <div v-else class="connections__empty">
        <p class="connections__empty-text">还没有连接</p>
        <button type="button" class="connections__empty-button" @click="openNew">新增连接</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.connections {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.connections__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.connections__title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.connections__add {
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

.connections__add:focus-visible,
.connections__host:focus-visible,
.connections__more:focus-visible,
.connections__menu-item:focus-visible,
.connections__empty-button:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.connections__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}

.connections__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.connections__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  padding: var(--sp-3);
}

.connections__confirm-text {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-300);
  line-height: 1.45;
}

.connections__confirm-actions {
  display: flex;
  gap: var(--sp-2);
}

.connections__confirm-cancel,
.connections__confirm-ok {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.connections__confirm-cancel {
  background: var(--surface-2);
  color: var(--fg);
}

.connections__confirm-ok {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

.connections__confirm-cancel:focus-visible,
.connections__confirm-ok:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.connections__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  overflow: hidden;
}

.connections__row {
  position: relative;
  display: flex;
  min-height: 56px;
  align-items: stretch;
  border-bottom: 1px solid var(--border-soft);
}

.connections__row:last-child {
  border-bottom: 0;
}

.connections__host {
  display: flex;
  min-width: 0;
  min-height: 56px;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  background: transparent;
  padding: 0 var(--sp-3);
  text-align: left;
}

.connections__host:active {
  background: var(--state-hover);
}

.connections__dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.connections__dot--on {
  background: var(--success);
}

.connections__dot--off {
  background: var(--error);
}

.connections__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.connections__name {
  overflow: hidden;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.connections__address {
  overflow: hidden;
  color: var(--fg-secondary);
  font: var(--fs-200) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.connections__key {
  flex: 0 0 auto;
  color: var(--fg-muted);
}

.connections__more {
  display: inline-flex;
  width: 48px;
  min-height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--fg-secondary);
  font-size: var(--fs-500);
}

.connections__more:active {
  background: var(--state-hover);
}

.connections__menu {
  position: absolute;
  inset-inline-end: var(--sp-2);
  inset-block-start: calc(100% - var(--sp-2));
  z-index: 10;
  display: flex;
  min-width: 140px;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-3);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}

.connections__menu-item {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: var(--sp-2);
  border: 0;
  background: transparent;
  padding: 0 var(--sp-3);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  text-align: left;
}

.connections__menu-item:active {
  background: var(--state-hover);
}

.connections__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-6) var(--sp-4);
}

.connections__empty-text {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
}

.connections__empty-button {
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
</style>
