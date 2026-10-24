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
 *
 * While the open chat is running the composer does not close: with a draft the
 * same button becomes 插话 (steering — pi delivers it at the next turn
 * boundary, inside the work already under way) and a second 排队 button appears
 * for a follow-up, which pi only delivers once the run has nothing left to do.
 * That difference is the whole point of having two buttons, so the copy never
 * says "send" for either. With an EMPTY draft there is nothing to deliver at
 * all, so “+” wins over both — the one useful action left is opening a command.
 *
 * ## Attachments (#2857)
 *
 * The paperclip stages files on the HOST before the message is sent, because
 * the agent reads paths, not bytes: a tile the user sees is already a remote
 * file, and a pick that is not staged is a pick the native SAF grant has to
 * survive. Staging therefore happens at attach time, and the draft is NOT
 * touched by it — `appendAttachmentPaths` runs once, at send time, so removing
 * a tile before sending leaves no text behind and re-ordering the tiles is
 * visible in the order the paths appear.
 *
 * A failed upload keeps the tiles that landed (the stager reports partial
 * success) and an error line under them; a cancel is silent. Attachment-only
 * sends are legal: the `Attached files:` block IS the message.
 */
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { formatBytes } from '@pocketshell/core';
import { appendAttachmentPaths } from '@pocketshell/core/shared/composerText';
import { insertionFor, type PiSlashCommand } from '../../pi/piSlashCommands';
import { optionInsertion, optionSourceFor, type PiCommandOption } from '../../pi/piCommandOptions';
import { opensBarePicker, parseSlashLine } from '../../pi/piInteractivity';
import type { ChatCommandState } from '../../session/chatCommands';
import type { ChatCommandOptions as ChatCommandOptionsCatalog } from '../../session/chatCommandOptions';
import {
  composerAttach,
  type ComposerAttachOutcome,
  type ComposerAttachProgress,
} from '../../session/composerAttach';
import ChatCommandSheet from './ChatCommandSheet.vue';
import ChatCommandOptions from './ChatCommandOptions.vue';
import { t } from '../../i18n';

/** One staged remote file: the path the agent gets, plus what to draw. */
interface StagedAttachment {
  path: string;
  /** Basename for the chip label; the full path is long on a phone. */
  name: string;
}

const props = withDefaults(defineProps<{
  send: (text: string, intent?: 'steer' | 'follow-up') => Promise<'sent' | 'busy' | 'error'>;
  sending: boolean;
  error: string | null;
  /** A note about a send that worked, e.g. a command only the terminal can show. */
  notice?: string | null;
  /** The open chat's conversation has a turn in flight. */
  running?: boolean;
  /** Built-ins plus whatever the host installed; empty still renders the sheet. */
  commands?: readonly PiSlashCommand[];
  commandsState?: ChatCommandState;
  /** The picker's rows and load state; absent means every pick inserts directly. */
  commandOptions?: ChatCommandOptionsCatalog | null;
  /** Controlled by the shell so Android Back closes the sheet, not the chat. */
  sheetOpen?: boolean;
  /**
   * Where staged files land: `~/.pocketshell/attachments/<scopeKey>/`. Empty
   * disables the paperclip — there is nowhere to put a file without a session.
   */
  attachmentScope?: string;
}>(), {
  commands: () => [],
  commandsState: 'idle',
  notice: null,
  running: false,
  commandOptions: null,
  sheetOpen: false,
  attachmentScope: '',
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
/** Files already on the host, waiting for this message. Send order = this order. */
const staged = ref<StagedAttachment[]>([]);
const attaching = ref(false);
const attachError = ref<string | null>(null);
/** The last ACKNOWLEDGED byte count of the batch in flight; null when idle. */
const attachProgress = ref<ComposerAttachProgress | null>(null);

const busy = computed(() => props.sending || attaching.value);

const canAttach = computed(() => !busy.value && props.attachmentScope !== '');

const canSend = computed(() => (
  !busy.value && (text.value.trim().length > 0 || staged.value.length > 0)
));

// `text === ''` rather than a trimmed check: a draft holding only spaces is
// still a draft the user typed into, so the 发送 button stays where it was.
// A staged file is also something to send, so the paperclip's pick flips the
// button out of “+” without the user typing a character.
const mode = computed<'more' | 'send'>(() => (
  text.value === '' && staged.value.length === 0 ? 'more' : 'send'
));

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

async function submit(intent?: 'steer' | 'follow-up'): Promise<void> {
  if (!canSend.value) return;
  // The staged paths are folded in HERE, once: the draft keeps the user's own
  // words, and a tile removed before sending leaves no trace in the text.
  const draft = appendAttachmentPaths(text.value, staged.value.map((item) => item.path));
  const slash = parseSlashLine(draft);
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
  let result: 'sent' | 'busy' | 'error';
  try {
    result = await props.send(draft, intent);
  } catch {
    result = 'error';
  }
  // Only a delivered message clears the tiles: a busy or failed send keeps
  // both the text and the files, which are already on the host.
  if (result === 'sent') {
    text.value = '';
    staged.value = [];
  }
}

/**
 * Pick and stage, in one tap. The picker is the shell's (`composerAttach`),
 * because staging needs the live connection ref and the host's `$HOME` — the
 * two things a view must not reach for itself.
 */
async function attach(): Promise<void> {
  if (!canAttach.value) return;
  attaching.value = true;
  attachError.value = null;
  attachProgress.value = null;
  let outcome: ComposerAttachOutcome;
  try {
    outcome = await composerAttach().attach({
      scopeKey: props.attachmentScope,
      onProgress: (progress) => { attachProgress.value = progress; },
    });
  } catch (error) {
    outcome = {
      paths: [],
      error: t('composer.attachFailed', {
        detail: error instanceof Error && error.message !== '' ? error.message : String(error),
      }),
    };
  } finally {
    attaching.value = false;
    attachProgress.value = null;
  }
  // A partial failure still reports its paths: those files ARE on the host and
  // dropping them would make the user upload them twice.
  if (outcome.paths.length > 0) {
    const known = new Set(staged.value.map((item) => item.path));
    for (const path of outcome.paths) {
      if (known.has(path)) continue;
      staged.value.push({ path, name: path.split('/').pop() ?? path });
    }
  }
  attachError.value = outcome.error;
}

function removeAttachment(path: string): void {
  staged.value = staged.value.filter((item) => item.path !== path);
}

/** The chip's icon: images read as images, everything else as a document. */
function attachmentIcon(name: string): 'image' | 'file' {
  return /\.(png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i.test(name) ? 'image' : 'file';
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
    <p v-if="attaching" class="composer__progress" role="status" data-testid="chat-composer-attach-progress">
      <template v-if="attachProgress">
        {{ t('composer.attachingProgress', {
          index: attachProgress.fileIndex,
          count: attachProgress.fileCount,
          done: formatBytes(attachProgress.batchBytesWritten),
          total: formatBytes(attachProgress.batchBytesTotal),
        }) }}
      </template>
      <template v-else>{{ t('composer.attaching') }}</template>
    </p>
    <p v-if="error" class="composer__error" role="alert" data-testid="chat-composer-error">
      {{ error }}
    </p>
    <p v-if="attachError" class="composer__error" role="alert" data-testid="chat-composer-attach-error">
      {{ attachError }}
    </p>
    <ul
      v-if="staged.length > 0"
      class="composer__chips"
      :aria-label="t('composer.attachments')"
      data-testid="chat-composer-attachments"
    >
      <li v-for="item in staged" :key="item.path" class="composer__chip">
        <AppIcon :name="attachmentIcon(item.name)" />
        <span class="composer__chip-name" :title="item.path">{{ item.name }}</span>
        <button
          type="button"
          class="composer__chip-remove"
          :aria-label="t('composer.removeAttachment', { name: item.name })"
          data-testid="chat-composer-attachment-remove"
          @click="removeAttachment(item.path)"
        >
          <AppIcon name="close" />
        </button>
      </li>
    </ul>
    <div class="composer__row">
      <button
        v-if="attachmentScope !== ''"
        type="button"
        class="composer__attach"
        :aria-label="attaching ? t('composer.attaching') : t('composer.attachAria')"
        :disabled="!canAttach"
        data-testid="chat-composer-attach"
        @click="attach"
      >
        <span v-if="attaching" class="composer__spinner" data-testid="chat-composer-attach-spinner">
          <AppIcon name="refresh" />
        </span>
        <AppIcon v-else name="paperclip" />
      </button>
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
        v-if="running"
        type="button"
        class="composer__queue"
        :aria-label="t('composer.followUpAria')"
        data-testid="chat-composer-follow-up"
        :disabled="!canSend"
        @click="submit('follow-up')"
      >
        {{ t('composer.followUp') }}
      </button>
      <button
        type="button"
        class="composer__send"
        :class="{ 'composer__send--more': mode === 'more' }"
        :aria-label="mode === 'more' ? t('composer.more') : running ? t('composer.steerAria') : t('composer.send')"
        :aria-expanded="mode === 'more' ? sheetOpen : undefined"
        :data-mode="mode"
        :data-intent="running ? 'steer' : 'send'"
        data-testid="chat-composer-send"
        :disabled="mode === 'send' && !canSend"
        @click="mode === 'more' ? openSheet() : submit(running ? 'steer' : undefined)"
      >
        <span v-if="sending" class="composer__spinner" data-testid="chat-composer-spinner">
          <AppIcon name="refresh" />
        </span>
        <AppIcon v-else-if="mode === 'more'" name="plus" />
        <span v-else>{{ running ? t('composer.steer') : t('composer.send') }}</span>
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
      :error="props.commandOptions?.error ?? null"
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

/* Measured, not estimated: the numbers come from acknowledged writes, so this
   line can sit still while the link is slow without ever lying. */
.composer__progress {
  margin: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: var(--sp-2);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
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

/* The paperclip: a way in, like “+”, so it wears the quiet border rather than
   the accent — a filled button here would read as the commit. */
.composer__attach {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg-secondary);
}

.composer__attach:active {
  background: var(--state-hover);
}

.composer__attach:disabled {
  opacity: var(--disabled-opacity);
}

/* One row, scrolled sideways: on a phone a wrapping grid of tiles would eat
   the turns above it, and the sender only needs to count them. */
.composer__chips {
  display: flex;
  gap: var(--sp-2);
  margin: 0;
  padding: 0 0 var(--sp-1);
  overflow-x: auto;
  list-style: none;
}

.composer__chip {
  display: inline-flex;
  max-width: 60%;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-2);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}

.composer__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}

.composer__chip-remove {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-muted);
}

.composer__chip-remove:active {
  background: var(--state-hover);
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
.composer__send:focus-visible,
.composer__queue:focus-visible,
.composer__attach:focus-visible,
.composer__chip-remove:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.composer__send {
  display: inline-flex;
  /* Auto width so the label （发送/插话/Steer/Queue） fits: a fixed 48 px
     clipped the longer English words. */
  min-width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  padding: 0 var(--sp-3);
  color: var(--on-accent);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
  white-space: nowrap;
}

/* A follow-up is the quieter of the two: it does nothing until the whole run
   is done, so it must not compete with 插话 for the thumb. */
.composer__queue {
  display: inline-flex;
  min-width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-2);
  color: var(--fg-secondary);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

.composer__queue:active {
  background: var(--state-hover);
}

/* “+” is a way in, not a commit: quiet until it is touched, so an empty draft
   does not read as a filled accent button. */
.composer__send--more {
  border-color: var(--border-strong);
  background: var(--surface-2);
  color: var(--fg);
}

.composer__send:disabled,
.composer__queue:disabled {
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
