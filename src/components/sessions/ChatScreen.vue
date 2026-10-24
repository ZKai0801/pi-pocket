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
  'open-terminal': [path: string];
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
// the catalog owns both so the composer never talks to the transport.
const commandOptions = createChatCommandOptions({
  projectPath: () => store.open?.cwd ?? null,
  listModels,
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

/** The chat's own project: the folder whose terminal the header opens. */
const terminalPath = computed(() => store.lastProject?.path ?? null);

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

function openTerminal(): void {
  const path = terminalPath.value;
  if (path !== null) emit('open-terminal', path);
}

interface ChatRow {
  key: string;
  kind: 'separator' | 'bubble' | 'model';
  time?: string;
  turn?: PiTurn;
  /** A model row's sentence, already in the active language. */
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

const rows = computed<ChatRow[]>(() => {
  const turns = store.open?.turns ?? [];
  // Pi appends a `model_change` entry per switch, so the dividers are the
  // file's own record — switches made in a terminal show up here too.
  const switches = (store.open?.modelSwitches ?? []).filter((item) => !isOpeningSwitch(item));
  // A switch belongs after the turn it was appended behind: bucket them by
  // that position so the walk below stays one pass over the turns.
  const byPosition = new Map<number, PiModelSwitch[]>();
  for (const item of switches) {
    const bucket = byPosition.get(item.afterTurns);
    if (bucket === undefined) byPosition.set(item.afterTurns, [item]);
    else bucket.push(item);
  }
  const out: ChatRow[] = [];
  const pushSwitches = (position: number, keyPrefix: string): void => {
    for (const item of byPosition.get(position) ?? []) {
      out.push({ key: `${keyPrefix}-${out.length}`, kind: 'model', text: t('chat.modelSwitchedTo', { to: item.to }) });
    }
  };
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
    pushSwitches(index + 1, `model-${index}`);
  });
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
</script>

<template>
  <section class="chat">
    <header class="chat__bar">
      <button type="button" class="chat__back" :aria-label="t('chat.backAria')" @click="goBack">
        <AppIcon name="arrow-left" />
      </button>
      <div class="chat__heading">
        <h1 class="chat__title">{{ title }}</h1>
        <!-- The model in effect, when the file (or a just-sent switch) says
             which one that is: small, under the name, never in its way. -->
        <p v-if="currentModel !== null" class="chat__model-name" data-testid="chat-model-name">{{ currentModel }}</p>
      </div>
      <button
        type="button"
        class="chat__terminal"
        :aria-label="t('chat.openTerminal')"
        data-testid="chat-open-terminal"
        :disabled="terminalPath === null"
        @click="openTerminal"
      >
        <AppIcon name="terminal" />
      </button>
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
            <ChatBubble v-else-if="row.kind === 'bubble' && row.turn !== undefined" :role="row.turn.role" :text="row.turn.text" />
            <p v-else-if="row.kind === 'model' && row.text !== undefined" class="chat__model" data-testid="chat-model-switch">
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
          <!-- Lines typed into the running turn: pi writes them to the file only
               when it delivers them, so they wait here as ghosts until then. -->
          <div v-for="item in store.pending" :key="item.id" class="chat__pending">
            <ChatBubble role="user" :text="item.text" />
            <p v-if="item.kind === 'follow-up'" class="chat__queued" data-testid="chat-queued">
              {{ t('chat.queued') }}
            </p>
          </div>
        </div>
      </template>
    </div>

    <footer class="chat__composer">
      <ChatComposer
        :send="store.send"
        :sending="store.sending"
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
  padding: var(--sp-3);
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

.chat__back {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--fg);
}

.chat__back:active {
  background: var(--state-hover);
}

.chat__back:focus-visible,
.chat__retry:focus-visible,
.chat__terminal:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.chat__terminal {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--accent);
}

.chat__terminal:active {
  background: var(--state-hover);
}

.chat__terminal:disabled {
  opacity: var(--disabled-opacity);
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

/* Not yet on the server: the bubble is the user's, but dimmed, so a queued
   follow-up never reads as something pi has already seen. */
.chat__pending {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: var(--sp-1);
  opacity: 0.72;
}

.chat__queued {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
}
</style>
