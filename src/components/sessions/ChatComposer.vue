<script setup lang="ts">
/**
 * The chat's composer (spec §7.4): multi-line text, tap to send, one turn at a
 * time. The text survives `'busy'` and `'error'` and is cleared only on
 * `'sent'`, so a failed send never loses what the user typed.
 *
 * The action slot has two modes. With text in the draft it is the filled 发送
 * button, unchanged. With an empty draft there is nothing to send, so it
 * becomes “+”, which opens the pi command sheet (§42) — the phone's cheapest
 * way to reach a `/command`, since typing a slash on a soft keyboard is the
 * slow part. A pick only INSERTS: the draft fills, the button turns back into
 * 发送, and the user still decides to send.
 *
 * A command with a fixed choice set (`/model`, `/thinking`) opens a second,
 * smaller sheet first and inserts the completed text form on a pick, so the
 * bare form never reaches pi — its own picker draws into the turn PTY, where
 * this chat has nowhere to show it. Tapping 发送 on the bare form takes the
 * same route rather than sending a line that leads nowhere.
 *
 * A command is sent through the store's command channel: it completes when pi
 * has it, not when a reply appears. `notice` is how that channel speaks when a
 * command ran in a screen only the terminal can show.
 */
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { insertionFor, type PiSlashCommand } from '../../pi/piSlashCommands';
import { optionInsertion, optionSourceFor, type PiCommandOption } from '../../pi/piCommandOptions';
import { opensBarePicker, parseSlashLine } from '../../pi/piInteractivity';
import type { ChatCommandState } from '../../session/chatCommands';
import type { ChatCommandOptions as ChatCommandOptionsCatalog } from '../../session/chatCommandOptions';
import ChatCommandSheet from './ChatCommandSheet.vue';
import ChatCommandOptions from './ChatCommandOptions.vue';
import { t } from '../../i18n';

const props = withDefaults(defineProps<{
  send: (text: string) => Promise<'sent' | 'busy' | 'error'>;
  sending: boolean;
  error: string | null;
  /** A note about a send that worked, e.g. a command only the terminal can show. */
  notice?: string | null;
  /** Built-ins plus whatever the host installed; empty still renders the sheet. */
  commands?: readonly PiSlashCommand[];
  commandsState?: ChatCommandState;
  /** The picker's rows and load state; absent means every pick inserts directly. */
  commandOptions?: ChatCommandOptionsCatalog | null;
  /** Controlled by the shell so Android Back closes the sheet, not the chat. */
  sheetOpen?: boolean;
}>(), {
  commands: () => [],
  commandsState: 'idle',
  notice: null,
  commandOptions: null,
  sheetOpen: false,
});

const emit = defineEmits<{
  'update:sheetOpen': [open: boolean];
  /** The shell owns loading; this fires every time the sheet opens. */
  'request-commands': [];
  /** This command needs its options, which only the shell can load. */
  'request-options': [command: PiSlashCommand];
}>();

const text = ref('');
const input = ref<HTMLTextAreaElement | null>(null);
/** The command whose options sheet is showing; null means the sheet is not. */
const pending = ref<PiSlashCommand | null>(null);

const canSend = computed(() => !props.sending && text.value.trim().length > 0);

// `text === ''` rather than a trimmed check: a draft holding only spaces is
// still a draft the user typed into, so the 发送 button stays where it was.
const mode = computed<'more' | 'send'>(() => (text.value === '' ? 'more' : 'send'));

const pendingOptions = computed<readonly PiCommandOption[]>(() => (
  pending.value === null || props.commandOptions === null
    ? []
    : props.commandOptions.optionsFor(pending.value.command)
));

const pendingState = computed(() => props.commandOptions?.state ?? 'idle');

// The options sheet is a step inside the command sheet: closing the outer one
// (Android Back, the ✕, a pick) must never leave the small one orphaned over
// the chat.
watch(() => props.sheetOpen, (open) => {
  if (!open) pending.value = null;
});

async function submit(): Promise<void> {
  if (!canSend.value) return;
  const slash = parseSlashLine(text.value);
  // The bare form of a picker command would open pi's own picker in the turn
  // PTY, where nothing can be shown or picked. Here the sheet is that picker,
  // so 发送 on the bare form opens it instead of sending a dead line.
  if (slash !== null && props.commandOptions !== null && opensBarePicker(slash)) {
    // The built-ins always carry the picker commands; the bare object is the
    // fallback for a composer mounted without the catalog's list.
    const known = props.commands.find((command) => command.command.toLowerCase() === slash.token);
    openOptionsFor(known ?? { command: slash.token, group: 'model' });
    return;
  }
  const draft = text.value;
  let result: 'sent' | 'busy' | 'error';
  try {
    result = await props.send(draft);
  } catch {
    result = 'error';
  }
  if (result === 'sent') text.value = '';
}

function openSheet(): void {
  emit('request-commands');
  emit('update:sheetOpen', true);
}

function closeSheet(): void {
  emit('update:sheetOpen', false);
}

/** Insert a picked command and put the caret back so an argument can follow. */
function finishPick(draft: string): void {
  text.value = draft;
  pending.value = null;
  emit('update:sheetOpen', false);
  void nextTick(() => input.value?.focus());
}

function pickCommand(command: PiSlashCommand): void {
  if (props.commandOptions !== null && optionSourceFor(command.command) !== null) {
    openOptionsFor(command);
    return;
  }
  finishPick(insertionFor(command));
}

/**
 * Open the picker for a command, whether the user picked its row or typed its
 * bare form. The catalog is keyed on the picker, not on the row.
 */
function openOptionsFor(command: PiSlashCommand): void {
  pending.value = command;
  emit('request-options', command);
}

function pickOption(option: PiCommandOption): void {
  const command = pending.value;
  if (command === null) return;
  finishPick(optionInsertion(command.command, option));
}

function closeOptions(): void {
  pending.value = null;
}

function retryOptions(): void {
  const command = pending.value;
  if (command !== null) emit('request-options', command);
}
</script>

<template>
  <div class="composer">
    <p v-if="notice" class="composer__notice" role="status" data-testid="chat-composer-notice">
      {{ notice }}
    </p>
    <p v-if="error" class="composer__error" role="alert" data-testid="chat-composer-error">
      {{ error }}
    </p>
    <div class="composer__row">
      <textarea
        ref="input"
        v-model="text"
        class="composer__input"
        rows="1"
        :placeholder="t('composer.placeholder')"
        :aria-label="t('composer.aria')"
        data-testid="chat-composer-input"
      />
      <button
        type="button"
        class="composer__send"
        :class="{ 'composer__send--more': mode === 'more' }"
        :aria-label="mode === 'more' ? t('composer.more') : t('composer.send')"
        :aria-expanded="mode === 'more' ? sheetOpen : undefined"
        :data-mode="mode"
        data-testid="chat-composer-send"
        :disabled="mode === 'send' && !canSend"
        @click="mode === 'more' ? openSheet() : submit()"
      >
        <span v-if="sending" class="composer__spinner" data-testid="chat-composer-spinner">
          <AppIcon name="refresh" />
        </span>
        <AppIcon v-else-if="mode === 'more'" name="plus" />
        <span v-else>{{ t('composer.send') }}</span>
      </button>
    </div>

    <ChatCommandSheet
      :open="sheetOpen"
      :commands="commands"
      :state="commandsState"
      @select="pickCommand"
      @close="closeSheet"
      @retry="emit('request-commands')"
    />

    <ChatCommandOptions
      :open="pending !== null"
      :command="pending?.command ?? ''"
      :options="pendingOptions"
      :state="pendingState"
      @select="pickOption"
      @close="closeOptions"
      @retry="retryOptions"
    />
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

/* A note, not a failure: the command did reach pi. Muted so it never reads
   as the red error it sits above. */
.composer__notice {
  margin: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: var(--sp-2);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.composer__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

.composer__input {
  min-height: 48px;
  max-height: 120px;
  /* `min-width: 0`: the textarea's intrinsic `cols` width is a flex floor,
     and the row must fit the send button beside it on a narrow phone. */
  min-width: 0;
  flex: 1 1 auto;
  resize: none;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: var(--sp-2);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  line-height: 1.45;
  outline: none;
}

.composer__input::placeholder {
  color: var(--fg-muted);
}

.composer__input:focus-visible,
.composer__send:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.composer__send {
  display: inline-flex;
  width: 48px;
  height: 48px;
  min-width: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

/* “+” is a way in, not a commit: quiet until it is touched, so an empty draft
   does not read as a filled accent button. */
.composer__send--more {
  border-color: var(--border-strong);
  background: var(--surface-2);
  color: var(--fg);
}

.composer__send:disabled {
  opacity: var(--disabled-opacity);
}

.composer__spinner {
  display: inline-flex;
  width: 20px;
  height: 20px;
  animation: composer-spin var(--dur-normal) linear infinite;
}

@keyframes composer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
