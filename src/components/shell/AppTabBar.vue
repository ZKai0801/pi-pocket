<script setup lang="ts">
import AppIcon, { type AppIconName } from '@ui/components/AppIcon.vue';

/** The phone shell's peer roots (spec §8.1): 连接 / 项目 / 会话 / 设置. */
export type PhoneTab = 'connections' | 'projects' | 'sessions' | 'settings';

interface TabItem {
  id: PhoneTab;
  label: string;
  icon: AppIconName;
}

/*
 * Every glyph already exists in @ui's AppIcon — the set is pinned in core, so
 * this component may only name existing marks. There is no chat-bubble mark, so
 * 会话 wears `activity`, the registry's "a running thing to watch" pulse, the
 * nearest existing register for a list of live Pi conversations.
 */
const TABS: readonly TabItem[] = [
  { id: 'connections', label: '连接', icon: 'terminal' },
  { id: 'projects', label: '项目', icon: 'folder' },
  { id: 'sessions', label: '会话', icon: 'activity' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const props = defineProps<{ modelValue: PhoneTab }>();
const emit = defineEmits<{ 'update:modelValue': [value: PhoneTab] }>();

function selectTab(tab: PhoneTab): void {
  if (tab !== props.modelValue) emit('update:modelValue', tab);
}
</script>

<template>
  <nav class="app-tab-bar" aria-label="主导航">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      type="button"
      class="app-tab-bar__item"
      :class="{ 'app-tab-bar__item--active': tab.id === modelValue }"
      :aria-current="tab.id === modelValue ? 'page' : undefined"
      :data-testid="`phone-tab-${tab.id}`"
      @click="selectTab(tab.id)"
    >
      <AppIcon :name="tab.icon" class="app-tab-bar__icon" />
      <span class="app-tab-bar__label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
/* Fixed to the viewport's bottom edge; the shell's own bottom-safe padding is
   not on this element's path, so it clears the Android navigation bar itself
   with the same `--android-shell-safe-bottom` the shell uses (falling back to
   the raw platform inset). */
.app-tab-bar {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  align-items: stretch;
  border-top: 1px solid var(--border-soft);
  background: var(--tabbar-bg);
  padding-bottom: var(--android-shell-safe-bottom, var(--safe-area-inset-bottom, 0px));
}

.app-tab-bar__item {
  display: flex;
  min-width: 0;
  min-height: 48px;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 0;
  background: transparent;
  padding: var(--sp-1) var(--sp-2);
  color: var(--tabbar-fg);
  font: var(--fw-medium) var(--fs-100) / 1.2 var(--font-ui);
  cursor: pointer;
}

.app-tab-bar__item:active,
.app-tab-bar__item:focus-visible {
  background: var(--state-hover);
}

.app-tab-bar__item:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: calc(-1 * var(--focus-ring-width));
}

.app-tab-bar__item--active {
  color: var(--tabbar-active);
}

.app-tab-bar__icon {
  width: 24px;
  height: 24px;
}

.app-tab-bar__label {
  font-size: var(--fs-100);
  line-height: 1.2;
}
</style>
