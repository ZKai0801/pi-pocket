<script setup lang="ts">
/**
 * The chat composer's command sheet (spec §42/§43 “sheet” surface): the pi
 * vocabulary the message box cannot make discoverable on a phone keyboard.
 *
 * Presentational — open state, the command list and its load state live
 * upstairs; this file owns only the filter text. A tap reports the row, and
 * the composer inserts it (nothing runs from here).
 */
import { computed, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import {
  commandDescription,
  filterPiCommands,
  groupPiCommands,
  piCommandGroupKey,
  type PiSlashCommand,
} from '../../pi/piSlashCommands';
import type { ChatCommandState } from '../../session/chatCommands';
import { t } from '../../i18n';

const props = withDefaults(defineProps<{
  open: boolean;
  commands: readonly PiSlashCommand[];
  state?: ChatCommandState;
}>(), {
  state: 'idle',
});

const emit = defineEmits<{
  select: [command: PiSlashCommand];
  close: [];
  retry: [];
}>();

const query = ref('');

// A sheet reopened for a different chat starts from the full list.
watch(() => props.open, (open) => {
  if (open) query.value = '';
});

const sections = computed(() => groupPiCommands(filterPiCommands(props.commands, query.value)));
const empty = computed(() => sections.value.length === 0);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="commands" data-testid="chat-command-sheet">
      <!-- The scrim is its own layer so a tap outside closes without stealing
           the row taps, and the panel keeps its own scroll. -->
      <div class="commands__scrim" @click="emit('close')" />
      <section
        class="commands__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="t('commands.title')"
      >
        <header class="commands__bar">
          <h2 class="commands__title">{{ t('commands.title') }}</h2>
          <button
            type="button"
            class="commands__close"
            :aria-label="t('commands.close')"
            data-testid="chat-command-close"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </header>

        <div class="commands__filters">
          <input
            v-model="query"
            class="commands__filter"
            type="search"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            :placeholder="t('commands.filter')"
            :aria-label="t('commands.filter')"
            data-testid="chat-command-filter"
          />
          <p class="commands__hint">{{ t('commands.hint') }}</p>
        </div>

        <p v-if="state === 'loading'" class="commands__status" data-testid="chat-command-loading">
          {{ t('commands.loading') }}
        </p>
        <p v-else-if="state === 'error'" class="commands__notice" role="status" data-testid="chat-command-notice">
          <span>{{ t('commands.failed') }}</span>
          <button type="button" class="commands__retry" @click="emit('retry')">
            <AppIcon name="refresh" /> {{ t('commands.retry') }}
          </button>
        </p>

        <div class="commands__list" data-testid="chat-command-list">
          <template v-for="section in sections" :key="section.group">
            <h3 class="commands__group">{{ t(piCommandGroupKey(section.group)) }}</h3>
            <button
              v-for="command in section.commands"
              :key="command.command"
              type="button"
              class="commands__row"
              :data-command="command.command"
              data-testid="chat-command-option"
              @click="emit('select', command)"
            >
              <span class="commands__line">
                <span class="commands__token">{{ command.command }}</span>
                <span v-if="command.argument" class="commands__arg">&lt;{{ command.argument }}&gt;</span>
                <span v-if="command.tuiOnly" class="commands__tag">{{ t('commands.tuiOnly') }}</span>
              </span>
              <span class="commands__desc">{{ commandDescription(command) }}</span>
            </button>
          </template>
          <p v-if="empty" class="commands__empty" data-testid="chat-command-empty">
            {{ t('commands.empty') }}
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/*
  A bottom sheet inside the tab bar's stacking order: above the tab bar (20),
  below the terminal (30). Teleported to <body>, so it carries the shell's own
  safe-area floor (the `src/styles.css` rule the key sheet repeats), and it
  leaves the chat visible behind the scrim.
*/
.commands {
  position: fixed;
  inset: 0;
  z-index: 25;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.commands__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
}

.commands__panel {
  position: relative;
  display: flex;
  max-height: 78%;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  background: var(--surface);
  padding-bottom: max(24px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
}

.commands__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  padding: var(--sp-1) var(--sp-2);
}

.commands__title {
  overflow: hidden;
  flex: 1 1 auto;
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commands__close {
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

.commands__close:active {
  background: var(--state-hover);
}

.commands__filters {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
}

.commands__filter {
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  outline: none;
}

.commands__filter::placeholder {
  color: var(--fg-muted);
}

.commands__hint {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
}

.commands__status,
.commands__notice,
.commands__empty {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.commands__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  background: var(--warning-soft);
  color: var(--warning);
}

.commands__retry {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: var(--sp-1);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  padding: 0 var(--sp-2);
  color: var(--accent);
  font: var(--fw-semibold) var(--fs-200) var(--font-ui);
}

.commands__list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  /* Air above the first row, because a scrolled row clips against this
     edge and otherwise reads as text overlapping the filter hint. */
  border-top: 1px solid var(--border-soft);
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
}

.commands__group {
  margin: var(--sp-2) 0 var(--sp-1);
  padding: 0 var(--sp-1);
  color: var(--fg-muted);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.commands__row {
  display: flex;
  min-height: 48px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  padding: var(--sp-2);
  text-align: left;
}

.commands__row:active {
  background: var(--state-selected);
}

.commands__line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-2);
}

.commands__token {
  color: var(--accent);
  font: var(--fw-semibold) var(--fs-300) var(--font-mono);
}

.commands__arg {
  color: var(--fg-muted);
  font: var(--fs-100) var(--font-mono);
  white-space: nowrap;
}

.commands__tag {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  line-height: 1.6;
}

.commands__desc {
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}

.commands__close:focus-visible,
.commands__filter:focus-visible,
.commands__retry:focus-visible,
.commands__row:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
