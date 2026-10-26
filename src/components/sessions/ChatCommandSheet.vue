<script setup lang="ts">
/**
 * The chat composer's “+” sheet (spec §42/§43 “sheet” surface): the things a
 * message can be given that the keyboard cannot offer — an upload first, then
 * the pi vocabulary the message box cannot make discoverable on a phone.
 *
 * Presentational — open state, the command list and its load state live
 * upstairs; this file owns only the filter text. A tap reports the row, and
 * the composer does the work (nothing uploads or inserts from here).
 *
 * The upload section is above the filter on purpose: it is not one of the
 * `/commands`, so filtering must never hide it, and it is the action most
 * users open this sheet for.
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
  /** False when there is no session to stage into, so the row is not offered. */
  canAttach?: boolean;
  /** A batch already in flight: the row stays, but it cannot start another. */
  attachBusy?: boolean;
}>(), {
  state: 'idle',
  canAttach: false,
  attachBusy: false,
});

const emit = defineEmits<{
  select: [command: PiSlashCommand];
  close: [];
  retry: [];
  attach: [];
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
            class="commands__close phone-icon-btn"
            :aria-label="t('commands.close')"
            data-testid="chat-command-close"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </header>

        <!-- Uploads first (§7.4/#2857): the one row here that is not a
             /command, so it sits above the filter that filters those. -->
        <div v-if="canAttach" class="commands__attach">
          <h3 class="commands__group">{{ t('commands.group.attach') }}</h3>
          <button
            type="button"
            class="commands__row commands__row--attach"
            :disabled="attachBusy"
            :aria-label="t('commands.attach')"
            data-testid="chat-command-attach"
            @click="emit('attach')"
          >
            <span :class="{ 'commands__attach-spinner': attachBusy }" data-testid="chat-command-attach-icon">
              <AppIcon :name="attachBusy ? 'refresh' : 'paperclip'" />
            </span>
            <span class="commands__attach-text">
              <span class="commands__attach-label">
                {{ attachBusy ? t('composer.attaching') : t('commands.attach') }}
              </span>
              <span class="commands__desc">{{ t('commands.attachDesc') }}</span>
            </span>
          </button>
        </div>

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
  padding-bottom: var(--android-shell-safe-bottom);
}

.commands__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  padding: var(--sp-1) var(--phone-page-gutter);
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

.commands__filters {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--phone-page-gutter);
}

.commands__filter {
  min-height: 48px;
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
  padding: var(--sp-2) var(--phone-page-gutter);
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
  min-height: 48px;
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

/* The upload row: icon beside the text, because it is a file action rather
   than a command token — the label carries it, not the monospace word. */
.commands__row--attach {
  flex-direction: row;
  align-items: center;
  gap: var(--sp-2);
  border: 1px solid var(--border);
  background: var(--surface-2);
}

.commands__row--attach:disabled {
  opacity: var(--disabled-opacity);
}

.commands__attach {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  border-bottom: 1px solid var(--border-soft);
  padding: 0 var(--sp-2) var(--sp-2);
}

.commands__attach-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.commands__attach-label {
  color: var(--fg);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
}

.commands__attach-spinner {
  display: inline-flex;
  animation: commands-spin var(--dur-normal) linear infinite;
}

@keyframes commands-spin {
  to {
    transform: rotate(360deg);
  }
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

.commands__filter:focus-visible,
.commands__retry:focus-visible,
.commands__row--attach:focus-visible,
.commands__row:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
