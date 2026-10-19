<script setup lang="ts">
/**
 * The terminal as a secondary screen (D5): a route-less overlay body that
 * attaches to one named aplexer session's PTY and pumps it through the
 * retained viewport. The shell opens it (打开终端) and installs the seam's
 * real implementation; this screen drives the PTY only through
 * `terminalPty()` and takes its name and display title as props, emitting
 * `close` when the header 关闭 is pressed.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import TerminalViewport from '../TerminalViewport.vue';
import { mobileMonoFontFamily, mobileTheme } from '../../sharedUiDefaults';
import { terminalGeometryChanged, type TerminalGeometry, type TerminalResizeRequest } from '../../terminalGeometry';
import { terminalPty, type TerminalPty } from '../../session/terminalPty';

const props = defineProps<{
  /** The aplexer session name to attach to (the opener resolves the mapping). */
  sessionName: string;
  /** Display title; defaults to the session name. */
  title?: string;
}>();

const emit = defineEmits<{ close: [] }>();

/** The viewport's exposed surface this screen drives (App.vue's handle, narrowed). */
interface TerminalViewportHandle {
  write(bytes: Uint8Array): void;
  focus(): void;
  fit(): Promise<TerminalResizeRequest | null>;
}

/** The phone's shared terminal defaults (sharedUiDefaults): the shared theme's terminal scheme and mono face. */
const terminalTheme = mobileTheme.terminal;
const terminalFontFamily = mobileMonoFontFamily;
const terminalFontSize = 13;

/** The grid a first attach falls back to before the viewport has measured. */
const FALLBACK_GEOMETRY: TerminalGeometry = { cols: 80, rows: 24 };

type TerminalPhase = 'connecting' | 'live' | 'error';
type TerminalErrorKind = 'uninstalled' | 'attach';

const viewport = ref<TerminalViewportHandle | null>(null);
const phase = ref<TerminalPhase>('connecting');
const errorKind = ref<TerminalErrorKind | null>(null);
const errorText = ref<string | null>(null);

const displayTitle = computed(() => props.title ?? props.sessionName);

let pty: TerminalPty | null = null;
let attached = false;
let released = false;
let lastResize: TerminalGeometry | null = null;
let sentGeometry: TerminalGeometry | null = null;
let attachToken = 0;

onMounted(() => {
  void attach();
});

onBeforeUnmount(() => {
  releasePty();
});

/**
 * Open the PTY for `sessionName` with the viewport's measured grid. The
 * seam is resolved lazily here: with no shell installed it is an error
 * state (请先连接-style), never a throw — house style for an uninstalled
 * seam.
 */
async function attach(): Promise<void> {
  const token = ++attachToken;
  phase.value = 'connecting';
  errorKind.value = null;
  errorText.value = null;

  let seam: TerminalPty;
  try {
    seam = terminalPty();
  } catch {
    phase.value = 'error';
    errorKind.value = 'uninstalled';
    errorText.value = '请先连接';
    return;
  }
  pty = seam;

  // The initial grid: the last resize the viewport emitted (it only emits
  // while enabled, so none before the first attach), else a fresh fit
  // measurement, else the 80x24 default before any measurement has landed.
  await nextTick();
  const measured = lastResize ?? (await viewport.value?.fit() ?? null);
  if (token !== attachToken) return;
  const geometry: TerminalGeometry = measured ?? FALLBACK_GEOMETRY;

  let result: { ok: boolean; error?: string };
  try {
    result = await seam.attach(props.sessionName, geometry);
  } catch {
    result = { ok: false };
  }
  if (token !== attachToken) return;

  if (!result.ok) {
    phase.value = 'error';
    errorKind.value = 'attach';
    errorText.value = result.error ?? '无法打开终端';
    return;
  }

  if (!attached) {
    // Register the data pump once; PTY output is decoded text and the
    // viewport's write takes bytes.
    seam.onData((chunk) => {
      viewport.value?.write(new TextEncoder().encode(chunk));
    });
    attached = true;
  }
  sentGeometry = geometry;
  phase.value = 'live';
  await nextTick();
  viewport.value?.focus();
}

function onInput(data: string): void {
  if (!attached || pty === null) return;
  const seam = pty;
  void seam.write(data).catch(() => {
    // A failed write leaves the pump dead; the next attach (重试) reopens
    // it. There is no per-keystroke error surface on this screen.
  });
}

function onResize(size: TerminalResizeRequest): void {
  const geometry: TerminalGeometry = { cols: size.cols, rows: size.rows };
  lastResize = geometry;
  if (!attached || pty === null) return;
  // Coalesce no-ops: the PTY already has this grid.
  if (!terminalGeometryChanged(sentGeometry, geometry)) return;
  sentGeometry = geometry;
  const seam = pty;
  void seam.resize(geometry.cols, geometry.rows).catch(() => {
    // A refused resize is not fatal; the next fit re-sends the grid.
  });
}

/**
 * Close the PTY and stop the pump. The guard flag makes close-then-unmount
 * a single detach, and the token bump invalidates an attach still in
 * flight so a leaving screen never opens a PTY nobody will close.
 */
function releasePty(): void {
  if (released) return;
  released = true;
  attachToken += 1;
  const seam = pty;
  pty = null;
  attached = false;
  if (seam === null) return;
  void seam.detach().catch(() => {
    // Releasing on the way out must not surface as a crash.
  });
}

function close(): void {
  releasePty();
  emit('close');
}
</script>

<template>
  <section class="terminal-screen" data-testid="terminal-screen">
    <header class="terminal-screen__bar">
      <AppIcon name="terminal" class="terminal-screen__glyph" />
      <h1 class="terminal-screen__title">{{ displayTitle }}</h1>
      <button
        type="button"
        class="terminal-screen__close"
        aria-label="关闭"
        data-testid="terminal-screen-close"
        @click="close"
      >
        <AppIcon name="close" />
      </button>
    </header>

    <div v-if="phase === 'error'" class="terminal-screen__failed" role="alert" data-testid="terminal-screen-error">
      <AppIcon name="alert-triangle" class="terminal-screen__failed-icon" />
      <p class="terminal-screen__error-box">{{ errorText }}</p>
      <p v-if="errorKind === 'attach'" class="terminal-screen__error-sub">会话：{{ sessionName }}</p>
      <div class="terminal-screen__actions">
        <button
          v-if="errorKind === 'attach'"
          type="button"
          class="terminal-screen__retry"
          data-testid="terminal-screen-retry"
          @click="void attach()"
        >
          <AppIcon name="refresh" /> 重试
        </button>
        <button
          type="button"
          class="terminal-screen__dismiss"
          data-testid="terminal-screen-dismiss"
          @click="close"
        >
          关闭
        </button>
      </div>
    </div>

    <div v-else class="terminal-screen__stage" data-testid="terminal-screen-viewport">
      <p v-if="phase === 'connecting'" class="terminal-screen__status">正在打开终端…</p>
      <TerminalViewport
        ref="viewport"
        class="terminal-screen__viewport"
        :enabled="phase === 'live'"
        :theme="terminalTheme"
        :font-family="terminalFontFamily"
        :font-size="terminalFontSize"
        @input="onInput"
        @resize="onResize"
      />
    </div>
  </section>
</template>

<style scoped>
.terminal-screen {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  box-sizing: border-box;
  height: 100%;
  padding: var(--sp-3);
  background: var(--bg);
}

.terminal-screen__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.terminal-screen__glyph {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--accent);
}

.terminal-screen__title {
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-screen__close {
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

.terminal-screen__close:active {
  background: var(--state-hover);
}

.terminal-screen__stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
}

.terminal-screen__status {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.45;
}

/* The global stylesheet clamps the viewport to a 220–360px dock; on this
   secondary screen it fills the remaining space instead. */
.terminal-screen__stage .terminal-screen__viewport {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  max-height: none;
}

.terminal-screen__failed {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-4);
  min-height: 0;
  padding: var(--sp-6) var(--sp-4);
}

.terminal-screen__failed-icon {
  width: 24px;
  height: 24px;
  color: var(--error);
}

.terminal-screen__error-box {
  margin: 0;
  max-width: 100%;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.terminal-screen__error-sub {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.45;
}

.terminal-screen__actions {
  display: flex;
  gap: var(--sp-3);
}

.terminal-screen__retry {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  padding: 0 var(--sp-5);
  color: var(--on-accent);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.terminal-screen__retry:active {
  background: var(--accent-dim);
}

.terminal-screen__dismiss {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-5);
  color: var(--fg);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.terminal-screen__dismiss:active {
  background: var(--state-hover);
}

.terminal-screen__close:focus-visible,
.terminal-screen__retry:focus-visible,
.terminal-screen__dismiss:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
