<script setup lang="ts">
/**
 * Read-only chat (spec §8.6): the open session's turns as WeChat-style
 * bubbles with day/time separators, pull-to-refresh re-reading the session
 * file, and the composer that sends one Pi turn at a time.
 * Navigation is store-driven: back is `closeChat()`, the chat shows while
 * `open !== null`.
 */
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { useSessionsStore } from '../../stores/sessions';
import { useConnectionsStore } from '../../stores/connections';
import type { PiTurn } from '../../pi/types';
import { discoverPiCommands, type PiSlashCommand } from '../../pi/piSlashCommands';
import { parsePiModelList } from '../../pi/piCommandOptions';
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
// (built-ins are always shown, whether or not the probe answers).
const commands = createChatCommandCatalog({
  projectPath: () => store.open?.cwd ?? null,
  discover: (project) => discoverPiCommands(piLive().transport(), project),
});

function loadCommands(): void {
  void commands.load({ force: commands.state === 'error' });
}

/** Same budget as the repository's other host probes: one exec, never a blocking wait. */
const MODEL_LIST_TIMEOUT_MS = 15_000;

// The resolved pi path outlives a single picker: `/model` can be opened
// several times in one chat and `resolvePiCommand` is a shell round-trip.
let resolvedPi: { host: string | null; command: string } | null = null;

/**
 * The models this host can reach, for the `/model` picker. pi lists only the
 * models whose provider has usable credentials, so the app cannot ship this
 * list; it runs `pi --list-models` in the chat's project instead.
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
  const result = await piLive().transport().exec(
    piListModelsCommand(command, project),
    MODEL_LIST_TIMEOUT_MS,
  );
  const models = parsePiModelList(result.stdout);
  // An empty list with a non-zero exit is a failure, not "no models": the
  // picker must offer its retry rather than claim the host has none.
  if (models.length === 0 && result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail === '' ? `the model list exited ${result.exitCode}` : detail);
  }
  return models;
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
  const name = store.open?.name;
  if (name) return name;
  const id = store.open?.id;
  return id ? id : t('chat.title');
});

/** The chat's own project: the folder whose terminal the header opens. */
const terminalPath = computed(() => store.lastProject?.path ?? null);

function openTerminal(): void {
  const path = terminalPath.value;
  if (path !== null) emit('open-terminal', path);
}

interface ChatRow {
  key: string;
  kind: 'separator' | 'bubble';
  time?: string;
  turn?: PiTurn;
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
  const out: ChatRow[] = [];
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
      <h1 class="chat__title">{{ title }}</h1>
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
          </template>
        </div>
      </template>
    </div>

    <footer class="chat__composer">
      <ChatComposer
        :send="store.send"
        :sending="store.sending"
        :error="store.sendError"
        :notice="store.sendNotice"
        :commands="commands.commands"
        :commands-state="commands.state"
        :command-options="commandOptions"
        :sheet-open="props.commandsOpen"
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

.chat__title {
  overflow: hidden;
  flex: 1 1 auto;
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
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
</style>
