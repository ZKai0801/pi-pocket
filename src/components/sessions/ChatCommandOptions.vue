<script setup lang="ts">
/**
 * The second step of a command pick (spec §42): a small sheet over the command
 * sheet that lists the tokens `/model` and `/thinking` accept, so the phone
 * never has to open pi's own picker — that one draws into the turn PTY, where
 * this chat cannot show it.
 *
 * Presentational: the rows and their load state come from upstairs.
 * Scrolling is the interaction — the list is touch-scrollable and a row is the
 * commit, which is why nothing is preselected on open.
 */
import AppIcon from '@ui/components/AppIcon.vue';
import type { PiCommandOption } from '../../pi/piCommandOptions';
import type { ChatOptionState } from '../../session/chatCommandOptions';
import { t } from '../../i18n';

withDefaults(defineProps<{
  open: boolean;
  /** The command being completed, shown as the sheet's title (`/model`). */
  command: string;
  options: readonly PiCommandOption[];
  state?: ChatOptionState;
  /** The host's own explanation for a failed probe, if it gave one. */
  error?: string | null;
}>(), {
  state: 'idle',
  error: null,
});

const emit = defineEmits<{
  select: [option: PiCommandOption];
  close: [];
  retry: [];
}>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="choices" data-testid="chat-command-options">
      <!-- Its own scrim, above the command sheet's: a tap outside goes one
           level back, never straight out of both. -->
      <div class="choices__scrim" @click="emit('close')" />
      <section
        class="choices__panel"
        role="dialog"
        aria-modal="true"
        :aria-label="command"
      >
        <header class="choices__bar">
          <h2 class="choices__title">{{ command }}</h2>
          <button
            type="button"
            class="choices__close"
            :aria-label="t('commands.options.close')"
            data-testid="chat-command-options-close"
            @click="emit('close')"
          >
            <AppIcon name="close" />
          </button>
        </header>

        <p v-if="state === 'loading'" class="choices__status" data-testid="chat-command-options-status">
          {{ t('commands.options.loading') }}
        </p>
        <div v-else-if="state === 'error'" class="choices__failed" data-testid="chat-command-options-status">
          <p class="choices__notice" role="status">
            <span>{{ t('commands.options.failed') }}</span>
            <button type="button" class="choices__retry" @click="emit('retry')">
              <AppIcon name="refresh" /> {{ t('commands.options.retry') }}
            </button>
          </p>
          <!-- The host's own words. Without them "could not read the list" is
               the end of the story: pi reports the reason on stderr. -->
          <p v-if="error" class="choices__reason" data-testid="chat-command-options-reason">
            {{ error }}
          </p>
        </div>
        <p v-else-if="options.length === 0" class="choices__status" data-testid="chat-command-options-status">
          {{ t('commands.options.empty') }}
        </p>

        <div v-else class="choices__list" data-testid="chat-command-options-list">
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            class="choices__row"
            :data-value="option.value"
            data-testid="chat-command-option-choice"
            @click="emit('select', option)"
          >
            <span class="choices__label">{{ option.label }}</span>
            <span v-if="option.detail" class="choices__detail">{{ option.detail }}</span>
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/*
  One level above the command sheet (25) and still below the terminal (30), so
  the sheet stays visible behind its own scrim: the pick reads as a step
  inside the sheet, not as a screen change.
*/
.choices {
  position: fixed;
  inset: 0;
  z-index: 26;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.choices__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
}

.choices__panel {
  position: relative;
  display: flex;
  max-height: 52%;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  background: var(--surface);
  padding-bottom: max(24px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
}

.choices__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  padding: var(--sp-1) var(--sp-2);
}

.choices__title {
  overflow: hidden;
  flex: 1 1 auto;
  margin: 0;
  padding-left: var(--sp-2);
  color: var(--accent);
  font: var(--fw-semibold) var(--fs-400) var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.choices__close {
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

.choices__close:active {
  background: var(--state-hover);
}

.choices__status,
.choices__notice {
  margin: 0;
  padding: var(--sp-3);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.choices__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  background: var(--warning-soft);
  color: var(--warning);
}

/* The host's reason, under the retry: smaller than the sentence above it so
   the actionable line stays the headline, and mono because it is usually a
   path or a command error verbatim. `--fg-secondary`, not `--fg-muted`: this
   is real information at 12px, where muted fails the contrast bar. */
.choices__reason {
  overflow-wrap: anywhere;
  margin: 0;
  border-top: 1px solid var(--border-soft);
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
  color: var(--fg-secondary);
  font: var(--fw-regular) var(--fs-100) var(--font-mono);
  line-height: 1.45;
}

.choices__retry {
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

.choices__list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
}

.choices__row {
  display: flex;
  min-height: 52px;
  flex: 0 0 auto;
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

.choices__row:active {
  background: var(--state-selected);
}

.choices__label {
  color: var(--fg);
  font: var(--fs-300) var(--font-mono);
  overflow-wrap: anywhere;
}

.choices__detail {
  color: var(--fg-muted);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
}

.choices__close:focus-visible,
.choices__retry:focus-visible,
.choices__row:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
