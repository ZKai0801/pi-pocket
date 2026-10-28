<script setup lang="ts">
/**
 * Read-only chat (spec §8.6): the open session's turns as WeChat-style
 * bubbles with day/time separators, pull-to-refresh re-reading the session
 * file, and the composer that sends one Pi turn at a time.
 * Navigation is store-driven: back is `closeChat()`, the chat shows while
 * `open !== null`.
 */
import { computed, nextTick, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { attachmentScopeKey } from '@pocketshell/core/shared/composerAttachments';
import { useSessionsStore } from '../../stores/sessions';
import { useConnectionsStore } from '../../stores/connections';
import type { PiModelSwitch, PiTurn } from '../../pi/types';
import { discoverPiCommands, type PiSlashCommand } from '../../pi/piSlashCommands';
import { agentRootsForConnection } from '../../pi/piAgentDir';
import {
  parsePiModelList,
  piModelListOutcome,
  type PiModelListOutcome,
} from '../../pi/piCommandOptions';
import { piListModelsCommand } from '../../pi/piCommands';
import { resolvePiCommand } from '../../pi/resolvePiCommand';
import { modelListsCache } from '../../pi/modelListCache';
import { piLive } from '../../session/piLive';
import { createChatCommandCatalog } from '../../session/chatCommands';
import { createChatCommandOptions } from '../../session/chatCommandOptions';
import ChatBubble from './ChatBubble.vue';
import ChatComposer from './ChatComposer.vue';
import { t } from '../../i18n';

const store = useSessionsStore();
const connections = useConnectionsStore();

const props = withDefaults(defineProps<{
  /** The composer's command sheet; the shell owns it so Android Back closes it. */
  commandsOpen?: boolean;
}>(), {
  commandsOpen: false,
});

const emit = defineEmits<{
  'update:commands-open': [open: boolean];
}>();

// The sheet lists pi's own vocabulary, so the host answers once per project
// (built-ins are always shown, whether or not the probe answers). The scan
// roots come from the host's own answer about where its agent tree lives —
// discovered once on the host's first connect and cached per host (the
// connect flow warms it; this is the same cache), so a relocated layout does
// not silently hide its extension commands.
const commands = createChatCommandCatalog({
  projectPath: () => store.open?.cwd ?? null,
  discover: async (project) => {
    const name = connections.activeName;
    const entry = name === null ? undefined : connections.hosts.find((host) => host.name === name);
    const { roots } = await agentRootsForConnection(piLive().transport(), {
      name,
      piSessionsDir: entry?.piSessionsDir,
    });
    return discoverPiCommands(piLive().transport(), project, roots);
  },
});

function loadCommands(): void {
  void commands.load({ force: commands.state === 'error' });
}

/**
 * One exec that starts pi, so it is not the repository's cheap-probe budget:
 * pi builds its session runtime (extensions compiled on the fly) before it
 * prints the list. 30 s is the slow-cold-start ceiling, not a typical wait.
 */
const MODEL_LIST_TIMEOUT_MS = 30_000;

// The resolved pi path outlives a single picker: `/model` can be opened
// several times in one chat and `resolvePiCommand` is a shell round-trip.
let resolvedPi: { host: string | null; command: string } | null = null;

/**
 * Run the probe once and describe a failure in the caller's words. A transport
 * fault (a timeout, a dropped connection) is caught here and becomes ordinary
 * text, because the sheet can only render text; `piModelListOutcome` judges
 * the run itself.
 */
async function runModelList(
  command: string,
  project: string,
  builtInsOnly: boolean,
): Promise<PiModelListOutcome> {
  let result: { stdout: string; stderr: string; exitCode: number | null };
  try {
    result = await piLive().transport().exec(
      piListModelsCommand(command, project, { builtInsOnly }),
      MODEL_LIST_TIMEOUT_MS,
    );
  } catch (error) {
    return { models: [], failure: error instanceof Error ? error.message : String(error) };
  }
  return piModelListOutcome(result.stdout, result.stderr, result.exitCode);
}

/**
 * The models this host can reach, for the `/model` picker. pi lists only the
 * models whose provider has usable credentials, so the app cannot ship this
 * list; it runs `pi --list-models` in the chat's project instead.
 *
 * A failure is retried once with `--no-extensions`: pi loads the extension
 * tree before it prints anything, so one broken extension turns the whole
 * probe into a non-zero exit. The built-in catalogue needs none of it, and a
 * provider registered by an extension is still typeable by hand.
 */
async function listModels(project: string): Promise<ReturnType<typeof parsePiModelList>> {
  const host = connections.activeName;
  const override = host === null
    ? undefined
    : connections.hosts.find((entry) => entry.name === host)?.piCommand?.trim();
  let command = resolvedPi !== null && resolvedPi.host === host ? resolvedPi.command : null;
  if (command === null) {
    const resolution = await resolvePiCommand(
      piLive().transport(),
      override !== undefined && override.length > 0 ? override : undefined,
    );
    if (!resolution.ok) throw new Error(resolution.error);
    command = resolution.command;
    resolvedPi = { host, command };
  }
  const full = await runModelList(command, project, false);
  if (full.failure === null) return full.models;
  const builtIns = await runModelList(command, project, true);
  if (builtIns.failure === null) return builtIns.models;
  // Both runs failed: report the full run's reason, it is the one that
  // describes the install the user actually has.
  throw new Error(full.failure);
}

// Options come from the app for `/thinking` and from the host for `/model`;
// the catalog owns both so the composer never talks to the transport. The
// model list is the slow probe (pi compiles its extension tree before it
// prints), so the durable backup paints the last confirmed rows at once and
// the probe re-confirms them in the background, keyed by host and project.
const commandOptions = createChatCommandOptions({
  projectPath: () => store.open?.cwd ?? null,
  hostName: () => connections.activeName,
  listModels,
  modelListCache: modelListsCache(),
});

function loadOptions(command: PiSlashCommand): void {
  void commandOptions.load(command.command, { force: commandOptions.state === 'error' });
}

const title = computed(() => {
  // A running conversation says so instead of naming itself: the question the
  // header answers while waiting is "is it still going?", not "which chat?".
  if (store.openRunning) return t('chat.running');
  const name = store.open?.name;
  if (name) return name;
  const id = store.open?.id;
  return id ? id : t('chat.title');
});

/**
 * The model in effect for this chat, as the header's small line: the file's
 * own record (its last `model_change`, or the model an assistant message
 * named), or — for the moment before a read confirms it — the last switch
 * this chat noted. Null when the file never said.
 */
const currentModel = computed(() => {
  const notes = store.modelNotes;
  const last = notes.length > 0 ? notes[notes.length - 1] : null;
  return last !== null ? last.to : store.open?.model ?? null;
});

/**
 * Where this chat's attachments land: `~/.pocketshell/attachments/<scope>/`.
 * The scope nests the workspace's basename with the session's own name, so one
 * project's files stay in one directory across all of its sessions — the shape
 * core's `attachmentScopeKey` defines for every platform. An open draft has no
 * session name yet, so it scopes to the workspace alone.
 */
const attachmentScope = computed(() => attachmentScopeKey(
  store.open?.name ?? 'draft',
  store.open?.cwd ?? store.lastProject?.path ?? null,
));

interface ChatRow {
  key: string;
  kind: 'separator' | 'bubble' | 'model' | 'note' | 'failure';
  time?: string;
  turn?: PiTurn;
  /**
   * A model row's sentence, already in the active language, or a command's own
   * line, which is pi's text and is shown as it came.
   */
  text?: string;
}

/**
 * The divider a model switch leaves in the transcript. A session's FIRST
 * switch — the one appended before any turn, which is the model the session
 * opened with rather than a change mid-conversation — draws no divider; the
 * header's model name says which model is in effect instead.
 */
function isOpeningSwitch(item: PiModelSwitch): boolean {
  return item.afterTurns === 0;
}

// A separator appears before the first timed turn, on a day change, and after
// any gap of more than five minutes; untimed turns (timestampMs 0) neither
// show one nor reset the clock.
const GAP_MS = 5 * 60 * 1000;

function formatTime(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hh}:${mm}`;
}

// The dialog card's message: pi's paragraphs with their layout blanks dropped.
// The null-normalising pending dialog is the template's one source: a store
// stub without the field must read as "no dialog", never as undefined.
const pendingDialog = computed(() => store.pendingDialog ?? null);
const dialogMessage = computed<string[]>(() =>
  (store.pendingDialog?.dialog.message ?? []).filter((line) => line.trim() !== ''));

/**
 * One bubble per loop iteration: an assistant turn's `segments` are the run's
 * separate replies, and rendering them together in one bubble is what made a
 * long run unreadable. A turn without segments (a user message, a cached parse
 * from before the field existed) is one bubble of its whole text.
 */
function bubbleTexts(turn: PiTurn): string[] {
  const segments = turn.segments;
  if (segments !== undefined && segments.length > 0) return segments;
  return [turn.text];
}

const rows = computed<ChatRow[]>(() => {
  const turns = store.open?.turns ?? [];
  // Pi appends a `model_change` entry per switch, so the dividers are the
  // file's own record — switches made in a terminal show up here too.
  const switches = (store.open?.modelSwitches ?? []).filter((item) => !isOpeningSwitch(item));
  // A switch, like a command's own line, belongs after the turn it was
  // appended behind: bucket both by that position so the walk below stays one
  // pass over the turns.
  const byPosition = new Map<number, ChatRow[]>();
  const place = (position: number, row: ChatRow): void => {
    const bucket = byPosition.get(position);
    if (bucket === undefined) byPosition.set(position, [row]);
    else bucket.push(row);
  };
  switches.forEach((item, index) => {
    place(item.afterTurns, {
      key: `model-${index}`,
      kind: 'model',
      text: t('chat.modelSwitchedTo', { to: item.to }),
    });
  });
  // What `/commands` printed for themselves, in the transcript at the point
  // they ran: a command appends no turn, so this is the only place the chat
  // can show that it happened (and what it said).
  for (const note of store.commandNotes) {
    place(note.afterTurns, { key: note.id, kind: 'note', text: note.text });
  }
  // A model call pi recorded as failed. It carries no text of its own — the
  // message that holds it is empty — so the transcript is the only place the
  // reader can learn that the attempt did not answer, and where it happened.
  (store.open?.errors ?? []).forEach((failure, index) => {
    place(failure.afterTurns, {
      key: `failure-${index}`,
      kind: 'failure',
      text: t('chat.modelError', {
        detail: failure.text !== '' ? failure.text : t('chat.modelErrorUnknown'),
      }),
    });
  });
  const out: ChatRow[] = [];
  const pushAt = (position: number, keyPrefix: string): void => {
    for (const row of byPosition.get(position) ?? []) {
      out.push({ ...row, key: `${keyPrefix}-${row.key}` });
    }
  };
  // Notes taken before any turn (a command run in an empty conversation) sit at
  // position 0, which the walk below never reaches.
  pushAt(0, 'before-first');
  let lastDayKey: string | null = null;
  let lastMs = 0;
  turns.forEach((turn, index) => {
    const ts = turn.timestampMs;
    if (ts > 0) {
      const date = new Date(ts);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const dayChanged = lastDayKey !== null && dayKey !== lastDayKey;
      const gapped = lastDayKey === null || ts - lastMs > GAP_MS;
      if (dayChanged || gapped) {
        out.push({ key: `sep-${index}`, kind: 'separator', time: formatTime(ts) });
        lastDayKey = dayKey;
        lastMs = ts;
      }
    }
    out.push({ key: `turn-${index}`, kind: 'bubble', turn });
    pushAt(index + 1, `after-${index}`);
  });
  // A position past the last turn (a note taken while the transcript looked
  // longer than the fresh parse says) still lands at the end, not nowhere.
  for (const position of [...byPosition.keys()].sort((a, b) => a - b)) {
    if (position > turns.length) pushAt(position, `tail-${position}`);
  }
  return out;
});

// Pull-to-refresh re-reads the open session file (R11.2's `refresh()`).
const scroller = ref<HTMLElement | null>(null);
const pullDistance = ref(0);
const refreshing = ref(false);
let touchStartY = 0;
let startedAtTop = false;
let touching = false;

// A send puts the user's own line on screen at once and the reply lands later,
// so the transcript has to follow new turns — but only for a reader who is
// already at the bottom: scrolling up to read history must not be yanked back.
const stickToBottom = ref(true);
const STICK_SLACK_PX = 48;

function onScroll(): void {
  const element = scroller.value;
  if (!element) return;
  stickToBottom.value =
    element.scrollHeight - element.scrollTop - element.clientHeight < STICK_SLACK_PX;
}

async function scrollToLatest(): Promise<void> {
  if (!stickToBottom.value) return;
  await nextTick();
  const element = scroller.value;
  if (element) element.scrollTop = element.scrollHeight;
}

// A different conversation opens at its newest message.
watch(
  () => store.openPath,
  () => {
    stickToBottom.value = true;
    void scrollToLatest();
  },
);

watch(
  () => store.open?.turns.length ?? 0,
  () => void scrollToLatest(),
);

// A line typed into the running turn shows up as a ghost before the session
// file has it, so the transcript has to follow that too.
watch(
  () => store.pending.length,
  () => void scrollToLatest(),
);

// A model switch is new content at the bottom of the transcript too — whether
// the file just recorded it or a draft chat noted it — and it adds no turn,
// so the length watch above would not fire for it.
watch(
  () => store.open?.modelSwitches?.length ?? 0,
  () => void scrollToLatest(),
);
watch(
  () => store.modelNotes.length,
  () => void scrollToLatest(),
);
watch(
  () => store.commandNotes.length,
  () => void scrollToLatest(),
);
watch(
  () => store.open?.errors?.length ?? 0,
  () => void scrollToLatest(),
);

const PULL_MAX_PX = 72;

const showPull = computed(() => pullDistance.value > 0 || refreshing.value);
const pullHeight = computed(() => (refreshing.value ? 24 : pullDistance.value));

function onPullStart(event: TouchEvent): void {
  const element = scroller.value;
  const y = event.touches[0]?.clientY;
  if (!element || y === undefined || refreshing.value) return;
  touchStartY = y;
  startedAtTop = element.scrollTop <= 0;
  touching = true;
}

function onPullMove(event: TouchEvent): void {
  if (!touching || !startedAtTop) return;
  const y = event.touches[0]?.clientY;
  if (y === undefined) return;
  const delta = y - touchStartY;
  // Half the finger travel, capped: the transcript resists being dragged down.
  pullDistance.value = delta > 0 ? Math.min(PULL_MAX_PX, delta * 0.5) : 0;
}

function onPullEnd(): void {
  if (!touching) return;
  touching = false;
  const release = pullDistance.value >= PULL_MAX_PX / 2;
  pullDistance.value = 0;
  if (release) void refresh();
}

async function refresh(): Promise<void> {
  if (refreshing.value || store.open === null) return;
  refreshing.value = true;
  try {
    await store.refresh();
  } finally {
    refreshing.value = false;
  }
}

function goBack(): void {
  store.closeChat();
}

/* ------------------------------------------------------------ resend */

/**
 * A line Pi never got keeps its bubble with a retry mark. Tapping the mark
 * asks before anything moves: the words the reader is about to edit back are
 * the ones that failed, and the bubble goes when they do — the transcript and
 * the composer must never hold the same line at once.
 */
const composer = ref<InstanceType<typeof ChatComposer> | null>(null);
const resendId = ref<string | null>(null);

const resendText = computed(() => {
  const id = resendId.value;
  if (id === null) return null;
  return store.pending.find((item) => item.id === id)?.text ?? null;
});

function askResend(id: string): void {
  resendId.value = id;
}

function cancelResend(): void {
  resendId.value = null;
}

function confirmResend(): void {
  const id = resendId.value;
  if (id === null) return;
  const text = store.retryPending(id);
  resendId.value = null;
  // The bubble is gone either way: a line that has already been taken back
  // (or has since landed in the file) leaves nothing to put in the composer.
  if (text !== null) composer.value?.setText(text);
}
</script>

<template>
  <section class="chat phone-page">
    <header class="chat__bar">
      <button
        type="button"
        class="chat__back phone-icon-btn"
        :aria-label="t('chat.backAria')"
        @click="goBack"
      >
        <AppIcon name="arrow-left" />
      </button>
      <div class="chat__heading">
        <h1 class="chat__title">{{ title }}</h1>
        <!-- The model in effect, when the file (or a just-sent switch) says
             which one that is: small, under the name, never in its way. -->
        <p v-if="currentModel !== null" class="chat__model-name" data-testid="chat-model-name">{{ currentModel }}</p>
      </div>
      <!-- The file is being read: a cold open paints the local backup first and
           a re-read leaves what is on screen in place, so the header is the one
           place that can say the chat is still catching up. Silent during a
           pull-to-refresh, whose own indicator is already at the top. -->
      <span
        v-if="store.opening && !refreshing"
        class="chat__busy"
        role="status"
        data-testid="chat-opening"
      >
        <AppIcon name="refresh" class="chat__busy-icon" />
        <span class="sr-only">{{ t('chat.opening') }}</span>
      </span>
    </header>

    <div
      class="chat__scroller"
      ref="scroller"
      @scroll.passive="onScroll"
      @touchstart.passive="onPullStart"
      @touchmove.passive="onPullMove"
      @touchend="onPullEnd"
    >
      <div v-if="showPull" class="chat__pull" :style="{ height: `${pullHeight}px` }">
        <AppIcon
          :name="refreshing ? 'refresh' : 'chevron-down'"
          class="chat__pull-icon"
          :class="{ 'chat__pull-icon--spinning': refreshing }"
        />
      </div>

      <p v-if="store.open === null && store.state === 'loading'" class="chat__status">{{ t('chat.opening') }}</p>

      <div v-else-if="store.open === null && store.state === 'error'" class="chat__failed">
        <p class="chat__error-box" role="alert">{{ store.error }}</p>
        <button type="button" class="chat__retry" @click="void refresh()">
          <AppIcon name="refresh" /> {{ t('chat.retry') }}
        </button>
      </div>

      <template v-else-if="store.open !== null">
        <div v-if="store.state === 'error'" class="chat__error" role="alert">
          <p class="chat__error-text">{{ store.error }}</p>
          <button type="button" class="chat__retry" @click="void refresh()">
            <AppIcon name="refresh" /> {{ t('chat.retry') }}
          </button>
        </div>

        <div class="chat__turns">
          <template v-for="row in rows" :key="row.key">
            <p v-if="row.kind === 'separator' && row.time !== undefined" class="chat__time">{{ row.time }}</p>
            <template v-else-if="row.kind === 'bubble' && row.turn !== undefined">
              <ChatBubble
                v-for="(segment, segmentIndex) in bubbleTexts(row.turn)"
                :key="`${row.key}-${segmentIndex}`"
                :role="row.turn.role"
                :text="segment"
              />
            </template>
            <p v-else-if="row.kind === 'model' && row.text !== undefined" class="chat__model" data-testid="chat-model-switch">
              {{ row.text }}
            </p>
            <!-- A command's own line (`Session name set: abcde`): plain text,
                 because it is the command talking, not the agent. -->
            <p v-else-if="row.kind === 'note' && row.text !== undefined" class="chat__note" data-testid="chat-command-note">
              {{ row.text }}
            </p>
            <!-- A failed model call (`Error: 500: ...`): plain text at the
                 transcript's edge, because it is the failure talking, not the
                 agent — and in the error colour, so it cannot be mistaken for
                 a reply. -->
            <p
              v-else-if="row.kind === 'failure' && row.text !== undefined"
              class="chat__failure"
              data-testid="chat-model-error"
            >
              {{ row.text }}
            </p>
          </template>
          <!-- A switch the session file has not recorded yet: the command
               was accepted moments ago and pi appends its `model_change`
               entry after the write this store already saw. The note stands
               until a read of the file overtakes it. -->
          <p
            v-for="note in store.modelNotes"
            :key="note.id"
            class="chat__model"
            data-testid="chat-model-switch"
          >
            {{ t('chat.modelSwitchedTo', { to: note.to }) }}
          </p>
          <!-- The reader's own lines that the file does not carry yet: a
               message on its way to Pi, or one typed into the run already in
               flight. Each carries what the delivery is doing — a spinner
               while the line is still travelling, a retry mark once it has
               failed, and nothing at all once Pi has it. The mark leads the
               row, so it sits to the left of the bubble and the bubble keeps
               the right edge every other self bubble has. -->
          <div
            v-for="item in store.pending"
            :key="item.id"
            class="chat__pending"
            :class="{
              'chat__pending--sending': item.status === 'sending',
              'chat__pending--failed': item.status === 'failed',
            }"
            data-testid="chat-pending"
          >
            <div class="chat__pending-line">
              <!-- Still travelling: the only thing on screen that says the
                   line has not reached Pi yet. -->
              <span
                v-if="item.status === 'sending'"
                class="chat__spinner"
                role="status"
                :aria-label="t('chat.sending')"
                data-testid="chat-pending-spinner"
              />
              <!-- Never arrived: the mark is the way back to the words. -->
              <button
                v-else-if="item.status === 'failed'"
                type="button"
                class="chat__failed-mark"
                :aria-label="t('chat.sendFailed')"
                data-testid="chat-pending-failed"
                @click="askResend(item.id)"
              >
                !
              </button>
              <ChatBubble role="user" :text="item.text" />
            </div>
            <p v-if="item.kind === 'follow-up'" class="chat__queued" data-testid="chat-queued">
              {{ t('chat.queued') }}
            </p>
            <p v-else-if="item.kind === 'steer'" class="chat__queued" data-testid="chat-steering">
              {{ t('chat.steering') }}
            </p>
          </div>
        </div>
      </template>
    </div>

    <footer class="chat__composer">
      <!-- A selection dialog a delivered `/command` left waiting on the turn's
           pane: pi drew it where this chat cannot render, Enter would answer
           its highlighted option, so it is answered here instead — natively. -->
      <section
        v-if="pendingDialog !== null"
        class="chat__dialog"
        data-testid="chat-dialog"
        role="alertdialog"
        :aria-label="t('chat.dialogHeading')"
      >
        <h3 class="chat__dialog-title">{{ pendingDialog.dialog.title }}</h3>
        <p
          v-for="(line, index) in dialogMessage"
          :key="index"
          class="chat__dialog-line"
        >{{ line }}</p>
        <p class="chat__dialog-options" data-testid="chat-dialog-options">
          <span
            v-for="(option, index) in pendingDialog.dialog.options"
            :key="option"
            class="chat__dialog-option"
            :data-selected="index === pendingDialog.dialog.selected"
          >{{ index === pendingDialog.dialog.selected ? '→ ' : '' }}{{ option }}</span>
        </p>
        <div class="chat__dialog-actions">
          <button
            type="button"
            class="chat__dialog-cancel"
            :disabled="store.dialogAnswering"
            data-testid="chat-dialog-cancel"
            @click="void store.answerPendingDialog('cancel')"
          >
            {{ t('chat.dialogCancel') }}
          </button>
          <button
            type="button"
            class="chat__dialog-confirm"
            :disabled="store.dialogAnswering"
            data-testid="chat-dialog-confirm"
            @click="void store.answerPendingDialog('confirm')"
          >
            {{ t('chat.dialogConfirm') }}
          </button>
        </div>
      </section>
      <!-- A line Pi never got, asked about before it moves: confirm hands the
           words back to the composer and takes the bubble away with them. -->
      <section
        v-if="resendText !== null"
        class="chat__resend"
        data-testid="chat-resend"
        role="alertdialog"
        :aria-label="t('chat.resendTitle')"
      >
        <h3 class="chat__dialog-title">{{ t('chat.resendTitle') }}</h3>
        <p class="chat__dialog-line">{{ t('chat.resendBody') }}</p>
        <p class="chat__resend-text">{{ resendText }}</p>
        <div class="chat__dialog-actions">
          <button
            type="button"
            class="chat__dialog-cancel"
            data-testid="chat-resend-cancel"
            @click="cancelResend"
          >
            {{ t('chat.resendCancel') }}
          </button>
          <button
            type="button"
            class="chat__dialog-confirm"
            data-testid="chat-resend-confirm"
            @click="confirmResend"
          >
            {{ t('chat.resendConfirm') }}
          </button>
        </div>
      </section>
      <ChatComposer
        ref="composer"
        :send="store.send"
        :sending="store.sending"
        :pending-count="store.pending.length"
        :error="store.sendError"
        :notice="store.sendNotice"
        :running="store.openRunning"
        :commands="commands.commands"
        :commands-state="commands.state"
        :command-options="commandOptions"
        :sheet-open="props.commandsOpen"
        :attachment-scope="store.open === null ? '' : attachmentScope"
        @update:sheet-open="emit('update:commands-open', $event)"
        @request-commands="loadCommands"
        @request-options="loadOptions"
      />
    </footer>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  background: var(--chat-bg);
  padding-block: var(--sp-3);
  /* One phone-width ratio for every bubble: a bubble is a share of the
     screen, never a share of its own content (a fenced block scrolls inside
     it). ChatBubble reads this; the fallback there keeps it standalone. */
  --chat-bubble-max-width: 78%;
}

.chat__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.chat__retry:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* The title and the model name stack in the header's middle column, which is
   the only part of the bar that may shrink. */
.chat__heading {
  flex: 1 1 auto;
  min-width: 0;
}

.chat__title {
  overflow: hidden;
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The model in effect: quiet small print under the name, so a reader can see
   which model is answering without the header growing to say it. */
.chat__model-name {
  overflow: hidden;
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The read-in-flight marker at the header's trailing edge: one fixed slot, so
   the title keeps its room and the bar does not grow when a slow read is
   announced. Deliberately slower than the pull icon — this one can spin for
   the length of a large session file, and a fast turn over that long reads as
   a fault rather than as work. */
.chat__busy {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--fg-secondary);
}

.chat__busy-icon {
  width: 18px;
  height: 18px;
  animation: chat-spin 900ms linear infinite;
}

/* Vertical only: the transcript must never pan sideways. A bubble that used
   to be widened by one long code line made `overflow-x` compute to auto here
   (an `auto` y-axis turns a `visible` x-axis into `auto`), which is what let
   the whole chat slide left and right. */
.chat__scroller {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}

.chat__pull {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
}

.chat__pull-icon {
  width: 18px;
  height: 18px;
  color: var(--fg-secondary);
}

.chat__pull-icon--spinning {
  animation: chat-spin var(--dur-normal) linear infinite;
}

@keyframes chat-spin {
  to {
    transform: rotate(360deg);
  }
}

.chat__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.45;
}

.chat__failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-4);
}

.chat__error-box {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.chat__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.chat__error-text {
  margin: 0;
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.chat__retry {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-3);
  color: var(--fg);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

.chat__failed .chat__retry {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: var(--fw-semibold);
}

.chat__retry:active {
  background: var(--state-hover);
}

.chat__failed .chat__retry:active {
  background: var(--accent-dim);
}

.chat__turns {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--sp-3);
  padding-bottom: var(--sp-3);
}

.chat__time {
  margin: var(--sp-2) 0 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  text-align: center;
}

/* The model-switch divider: the same quiet centered line as a time separator,
   so it reads as the same family of transcript markers. The `--- … ---` in
   the copy is what makes it a break rather than a timestamp — everything
   after it was answered by a different model. */
.chat__model {
  margin: var(--sp-2) 0 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
  text-align: center;
  overflow-wrap: anywhere;
}

/* What a `/command` printed for itself. Plain text and start-aligned: it is
   output, not a sentence about the conversation, and it must not read as a
   bubble from either side. */
.chat__note {
  margin: var(--sp-2) 0 0;
  padding-inline: var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fs-200);
  line-height: 1.45;
  text-align: start;
  overflow-wrap: anywhere;
}

/* A failed model call (`Error: 500: ...`). A plain row, not a bubble: nobody
   said it, the run did — and the error colour plus the soft box keep it from
   reading as any part of the conversation. */
.chat__failure {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2);
  border-inline-start: 2px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
  text-align: start;
  overflow-wrap: anywhere;
}

/* The native twin of the dialog a `/command` left on the turn's pane: above
   the composer, because nothing may be sent past it. */
.chat__dialog {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin: 0 0 var(--sp-2);
  border: 1px solid var(--warning);
  border-radius: var(--r-md);
  background: var(--warning-soft);
  padding: var(--sp-2) var(--sp-3);
}

.chat__dialog-title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  overflow-wrap: anywhere;
}

.chat__dialog-line {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  overflow-wrap: anywhere;
}

.chat__dialog-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin: var(--sp-1) 0 0;
  color: var(--fg);
  font: var(--fs-200) var(--font-mono);
}

.chat__dialog-option[data-selected='true'] {
  color: var(--warning);
  font-weight: var(--fw-semibold);
}

.chat__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}

.chat__dialog-cancel,
.chat__dialog-confirm {
  min-height: 48px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 0 var(--sp-3);
  background: var(--surface);
  color: var(--fg);
  font: var(--fw-semibold) var(--fs-200) var(--font-ui);
}

.chat__dialog-confirm {
  border-color: var(--warning);
  color: var(--warning);
}

.chat__dialog-cancel:disabled,
.chat__dialog-confirm:disabled {
  opacity: 0.5;
}

.chat__dialog-cancel:focus-visible,
.chat__dialog-confirm:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

/* Not yet on the server: the bubble is the user's, but dimmed, so a queued
   follow-up never reads as something pi has already seen. Only a line still
   travelling is dimmed — one Pi has, or one that failed, is the reader's to
   read at full strength. */
.chat__pending {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: var(--sp-1);
}

.chat__pending--sending {
  opacity: 0.72;
}

/* The mark and the bubble share a row: the mark on the left, centred on the
   bubble, the bubble on the right edge every other self bubble sits on.
   The row takes the full column width on purpose. A shrink-to-fit row would
   make the bubble's own `max-width: 78%` resolve against the row instead of
   against the column, so the pending bubble would be a different size from —
   and no longer flush with — the bubbles already in the transcript. */
.chat__pending-line {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  width: 100%;
  min-width: 0;
}

/* The bubble's own `align-self: flex-end` means "bottom" in a row, not
   "right": the row already puts it on the right, so it only has to stay
   level with the mark's centre. */
.chat__pending-line .bubble {
  align-self: center;
}

/* The line is on its way: a ring that turns until Pi has the bytes. It sits
   at the vertical centre of the bubble, so `align-items: center` on the row
   does the placing — no bottom margin to shift it off centre. */
.chat__spinner {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--fg-muted);
  border-radius: 50%;
  animation: chat-spin 0.8s linear infinite;
}

@keyframes chat-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat__spinner {
    animation-duration: 2.4s;
  }
}

/* It never arrived: the mark is a button, because it is the way back to the
   words — a tap asks, and confirming puts them in the composer. */
.chat__failed-mark {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  /* A thumb has to hit it: the ring is drawn small, the target is not. */
  width: 32px;
  height: 32px;
  border: 1px solid var(--error);
  border-radius: 50%;
  background: var(--error-soft);
  color: var(--error);
  font: var(--fw-semibold) var(--fs-300) var(--font-ui);
}

.chat__failed-mark:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.chat__resend {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin: 0 0 var(--sp-2);
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2) var(--sp-3);
}

/* The words themselves, so the reader can tell which line the question is
   about before deciding. */
.chat__resend-text {
  margin: 0;
  max-height: 4.8em;
  overflow: hidden;
  color: var(--fg);
  font-size: var(--fs-200);
  overflow-wrap: anywhere;
}

.chat__queued {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
}
</style>
