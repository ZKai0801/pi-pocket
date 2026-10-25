<script setup lang="ts">
/**
 * The single phone shell (#2936, D42): one root mounted by `src/main.ts`.
 *
 * It owns the active tab, the tab views, and the live connection. The
 * connection itself is the repo-local `ConnectionController` bound to the
 * Capacitor SSH capability; this shell hands it to the rest of the app only
 * through the narrow seams the stores consume (`installConnectionPort`,
 * `installPiLive`) and takes them back on disconnect/unmount.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { useSettingsStore } from '@ui/app/stores/settings';
import {
  type ConnectionSnapshot,
  type HostKeyTrustChoice,
  type SshHostTarget,
  isSshResponseFor,
} from '@pocketshell/core';
import HostKeyTrustPrompt from '@ui/app/components/HostKeyTrustPrompt.vue';
import AppTabBar, { type PhoneTab } from '../components/shell/AppTabBar.vue';
import ConnectionsList from '../components/connections/ConnectionsList.vue';
import ProjectsList from '../components/projects/ProjectsList.vue';
import SessionList from '../components/sessions/SessionList.vue';
import ChatScreen from '../components/sessions/ChatScreen.vue';
import SettingsTab from '../components/settings/SettingsTab.vue';
import { installThemeSync } from './themeSync';
import { installLocaleSync } from './localeSync';
import {
  ConnectionController,
  MOBILE_BACKGROUND_GRACE_MS,
  MOBILE_RECONNECT_ON_RETURN,
} from '../session/connectionController';
import { hostKeyAnswer, hostKeyCard, hostKeyRefusalMessage } from '../session/hostKeyCard';
import { type HomeSurface } from '../session/homeSurface';
import {
  clearViews,
  createBackStack,
  createShellBackNavigation,
  installBackButton,
  installBackNavigation,
  runHomeBack,
} from './backNavigation';
import { installAppStateLifecycle } from './appStateLifecycle';
import {
  decideLaunchReconnect,
  launchReconnectAttempted,
  markLaunchReconnectAttempted,
} from './launchReconnect';
import { createConnectionSnapshotSync } from './connectionSnapshot';
import { installConnectionPort, type ConnectionPort } from '../session/connectionPort';
import {
  installPiLive,
  type PiDirectoryEntry,
  type PiLive,
  type PiRemoteContext,
} from '../session/piLive';
import { installTurnPtyOpener, type TurnPtyOpener } from '../session/turnPty';
import { installComposerAttach, type ComposerAttachLive } from '../session/composerAttach';
import { platformInput } from '../session/platformInput';
import { createAndroidAttachmentPort } from '../platform/android/attachmentPort';
import { createPiTransport } from '../pi/piTransport';
import { PI_SESSION_DIR_ENV } from '../pi/sessionRoot';
import { useSessionsStore } from '../stores/sessions';
import { useConnectionsStore } from '../stores/connections';
import { useProjectsStore } from '../stores/projects';
import { sshCapability, type SftpReadWithOffsetOptions } from '../native/sshCapability';
import { keyboardInsets, type KeyboardInsetsState } from '../native/keyboardInsets';
import { createKeyboardInsetsStateSync } from '../native/keyboardInsetsState';
import { createLocalTrustStore } from '../platform/android/trustStore';
import { createTerminalTextDecoder } from './terminalText';

const EXEC_TIMEOUT_MS = 15_000;
const TURN_PTY_MAX_BYTES = 32_768;
const TURN_PTY_WAIT_MS = 250;
const TURN_TERM = 'xterm-256color';
const nativePlatform = Capacitor.getPlatform();

const activeTab = ref<PhoneTab>('connections');
const sessions = useSessionsStore();
const connections = useConnectionsStore();
const projects = useProjectsStore();
const sharedSettings = useSettingsStore();

const snapshot = ref<ConnectionSnapshot | null>(null);
const forwardSnapshot = createConnectionSnapshotSync<ConnectionSnapshot>({
  onSnapshot: (value) => { snapshot.value = value; },
  apply: (phase) => connections.applyConnectionSnapshot(phase),
});

/* ----------------------------------------------------------- back stack */

const TAB_HOME_SURFACE: Record<PhoneTab, HomeSurface> = {
  connections: 'connection',
  projects: 'sessions',
  sessions: 'sessions',
  // 设置 has no workspace behind it, so Back at its root behaves like the
  // 连接 tab's: the shell backgrounds the app instead of stepping anywhere.
  settings: 'connection',
};

/**
 * The chat composer's command sheet. The chat is not a back-stack view (Back at
 * the 会话 root closes the chat), so the sheet is an overlay instead: Android
 * Back dismisses it and leaves the conversation open.
 */
const chatCommandsOpen = ref(false);

function setChatCommandsOpen(open: boolean): void {
  chatCommandsOpen.value = open;
}

/** Topmost overlay/sheet wins: the chat's command sheet, then the 会话 tick list, then the Projects directory sheet. */
function closeTopmostOverlay(): boolean {
  if (chatCommandsOpen.value) {
    chatCommandsOpen.value = false;
    return true;
  }
  // Back out of a tick list before it becomes a tab: the ticks are one
  // gesture from deleting files on the host, so they must be easy to drop.
  if (sessions.selecting) {
    sessions.cancelSelection();
    return true;
  }
  if (projects.browse.open) {
    projects.closeBrowse();
    return true;
  }
  return false;
}

const backStack = createBackStack({
  getActiveTab: () => activeTab.value,
  onHomeBack: () => runHomeBack({
    getSurface: () => TAB_HOME_SURFACE[activeTab.value],
    hasLiveConnection: () => connections.status === 'connected',
    minimize: () => CapacitorApp.minimizeApp(),
    onError: (error) => {
      console.error('Could not minimize the app from Android Back.', error);
    },
  }),
});

const backNavigationOwner = createShellBackNavigation({
  stack: backStack,
  getActiveTab: () => activeTab.value,
  closeOverlay: closeTopmostOverlay,
  onPopped: (tab) => {
    if (tab === 'sessions' && backStack.current('sessions') === null) sessions.closeChat();
  },
});

/** The pushed view of the 连接 tab: `'editor'`, or `'keys'` stacked above it. */
const connectionView = computed(() => backStack.current('connections'));

/**
 * Tapping a project in the 项目 tab selects it and lands on the 会话 tab: the
 * shell owns the active tab, so the list asks for the move instead of owning
 * tab state (spec §8.5). The sessions store's own selection watch loads the
 * project's conversations, so the list is already filling in on arrival.
 */
function openProjectSessions(): void {
  activeTab.value = 'sessions';
}

function setEditorOpen(open: boolean): void {
  if (open) backStack.push('connections', 'editor');
  // Closing the editor drops a key sheet stacked above it as well (R34).
  else clearViews(backStack, 'connections');
}

/**
 * R34: the key vault sheet is a view of the 连接 tab the editor pushes, so
 * Android Back pops the sheet and leaves the editor open. The sheet's own
 * state stays in the editor; only this entry lives here.
 */
function setKeysOpen(open: boolean): void {
  if (open) {
    if (backStack.current('connections') !== 'keys') backStack.push('connections', 'keys');
    return;
  }
  if (backStack.current('connections') === 'keys') backStack.pop('connections');
}

// A chat is a pushed view of the 会话 tab, so Back can pop it (spec §8.1).
watch(
  () => sessions.open,
  (open) => {
    if (open !== null) {
      if (backStack.current('sessions') !== 'chat') backStack.push('sessions', 'chat');
    } else if (backStack.current('sessions') === 'chat') {
      backStack.pop('sessions');
    }
  },
);

// The command sheet belongs to one open chat: leaving the tab, closing the
// chat or switching to another one takes the sheet with it. (Back is handled
// in `closeTopmostOverlay`, so the chat survives that press.)
watch(
  [activeTab, () => sessions.open],
  () => {
    chatCommandsOpen.value = false;
  },
);

// A new generation means a reconnect: the PTY that was watching a turn
// belonged to the old transport, but the turn did not — Pi runs in a tmux
// session on the host (see piTurn.ts), so the runner only re-attaches. This
// used to dispose the runner, which killed in-flight work server-side on
// every reconnect instead of letting it finish.
watch(
  () => snapshot.value?.generationId,
  (next, previous) => {
    if (next === previous) return;
    sessions.rebindTurnRunner();
  },
);

// A turn whose reply landed while this phone was not looking leaves an idle
// Pi in its tmux session — the runner that would have closed it is gone. The
// sweep is gated on the connected phase, not on `generationId`: a generation
// is minted when the dial starts, and nothing can be read before it lands.
watch(
  () => (snapshot.value?.phase === 'connected' ? snapshot.value.generationId : null),
  (next, previous) => {
    if (next === null || next === previous) return;
    void sessions.sweepPendingTurns();
  },
);
const keyboardVisible = ref(false);
const connectionMessage = ref('');

let controller: ConnectionController | null = null;
let dialedTarget: SshHostTarget | null = null;
let removeControllerSnapshot: (() => void) | undefined;
let removeBackButton: (() => void) | undefined;
let stopLaunchReconnectWatch: (() => void) | undefined;
let disposeAppStateLifecycle: (() => void) | undefined;
let stopThemeSync: (() => void) | undefined;
let stopLocaleSync: (() => void) | undefined;
let activePassphrase: string | undefined;
let requestSequence = 0;

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ trust */

/**
 * The same pins the legacy phone screens wrote
 * (`pocketshell.ssh.host-key.<hostId>`), read through the Android platform
 * store so a pin recorded by either shell is honoured here.
 */
const trustStore = createLocalTrustStore(localStorage);

const trustDecision = computed(() => snapshot.value?.trustDecision ?? null);
const trustCard = computed(() => (
  trustDecision.value && dialedTarget
    ? hostKeyCard(trustDecision.value, {
      hostname: dialedTarget.hostname,
      port: dialedTarget.port,
      username: dialedTarget.username,
    })
    : null
));

/* ------------------------------------------------------- connection owner */

function bindController(next: ConnectionController): void {
  removeControllerSnapshot?.();
  controller = next;
  removeControllerSnapshot = next.subscribe(forwardSnapshot);
}

function releaseSeams(): void {
  installPiLive(null);
  installTurnPtyOpener(null);
  installComposerAttach(null);
}

function installSeams(): void {
  installPiLive(piLiveImplementation);
  installTurnPtyOpener(turnPtyImplementation);
  installComposerAttach(composerAttachImplementation);
}

async function closeController(): Promise<void> {
  removeControllerSnapshot?.();
  removeControllerSnapshot = undefined;
  const active = controller;
  controller = null;
  dialedTarget = null;
  snapshot.value = null;
  sessions.disposeTurnRunner();
  releaseSeams();
  if (active) await active.close().catch(() => undefined);
}

const USABLE_PHASES = new Set(['connected', 'listing', 'attaching', 'live']);

/**
 * Remember the host as this phone's launch host, so the next cold start dials
 * it by itself instead of waiting for a tap. It is written to the shared
 * settings store's `defaultHost` — the same field the shared host picker
 * reads — so phone and web agree on "the host to open", and a phone that has
 * never connected simply has nothing to restore.
 */
function rememberLaunchHost(target: SshHostTarget): void {
  // The alias, not `target.hostId`: a dial target names a host by its endpoint
  // (`user@host:port`, from `AndroidHostStore.resolve`), while the saved list —
  // and so the next launch's decision — is keyed by the name the user sees.
  // Remembering the endpoint made every cold start look like a host that had
  // since been deleted, and the launch dial was skipped silently.
  const name = connections.hosts.find((host) => host.hostname === target.hostname
    && host.port === target.port
    && host.user === target.username)?.name;
  if (name === undefined || name.trim() === '') {
    console.error('Could not remember the launch host: no saved host matches', target.hostname);
    return;
  }
  sharedSettings.defaultHost = name;
}

const connectionPort: ConnectionPort = {
  async connect(target) {
    // A re-request for the host this shell already holds (the connections
    // store re-dials after a host-key accept) must not close and redial it.
    if (
      controller
      && dialedTarget?.hostId === target.hostId
      && USABLE_PHASES.has(controller.getSnapshot().phase)
    ) {
      connectionMessage.value = '';
      rememberLaunchHost(target);
      installSeams();
      return { ok: true };
    }
    await closeController();
    const next = new ConnectionController({ trustStore });
    bindController(next);
    dialedTarget = target;
    activePassphrase = target.credential.kind === 'key-handle'
      ? target.credential.passphrase ?? undefined
      : undefined;
    const result = await next.connect(target);
    if (!result.ok) {
      // The passphrase is only needed to answer a pending trust prompt.
      if (next.getSnapshot().phase !== 'awaiting-trust') activePassphrase = undefined;
      return { ok: false };
    }
    activePassphrase = undefined;
    // A successful dial retires any message left by an earlier host's refusal.
    connectionMessage.value = '';
    rememberLaunchHost(target);
    installSeams();
    return { ok: true };
  },
  async disconnect() {
    await closeController();
  },
};

/* --------------------------------------------------------------- Pi seam */

function liveConnectionRef(): { connectionId: string; generationId: string } {
  const value = snapshot.value;
  if (!value?.connectionId || !value.generationId) {
    throw new Error('No live SSH connection.');
  }
  return { connectionId: value.connectionId, generationId: value.generationId };
}

function nextRequestId(): string {
  requestSequence += 1;
  return `phone-shell-${requestSequence}`;
}

const piTransport = createPiTransport(
  {
    async exec(command, { timeoutMs }) {
      const active = controller;
      if (!active) throw new Error('No live SSH connection.');
      const result = await active.runHostCommand(command, timeoutMs);
      if (!result.ok) throw new Error(result.message);
      return {
        stdout: result.value.stdout,
        stderr: result.value.stderr,
        exitCode: result.value.exitCode,
      };
    },
  },
  {
    async sftpRead({ path, maxBytes, offset }) {
      const connection = liveConnectionRef();
      const requestId = nextRequestId();
      // The Android plugin reads an optional byte `offset` so a large session
      // file can be paged instead of head-truncated (see
      // SftpReadWithOffsetOptions); absent offset behaves exactly like the
      // core contract's head-anchored read.
      const options: SftpReadWithOffsetOptions = {
        ...connection,
        requestId,
        path,
        maxBytes,
        ...(offset === undefined ? {} : { offset }),
      };
      const result = await sshCapability.sftpRead(options);
      if (result.requestId !== requestId) throw new Error('SFTP read returned a stale request.');
      return { dataBase64: result.dataBase64 };
    },
  },
);

const piLiveImplementation: PiLive = {
  transport() {
    return piTransport;
  },
  async remoteContext(): Promise<PiRemoteContext> {
    const active = controller;
    if (!active) throw new Error('No live SSH connection.');
    const command = `printf '%s\\n%s\\n' "$HOME" "\${${PI_SESSION_DIR_ENV}-}"`;
    const result = await active.runHostCommand(command, EXEC_TIMEOUT_MS);
    if (!result.ok) throw new Error(result.message);
    const [home = '', sessionDir = ''] = result.value.stdout.split('\n');
    const env: Record<string, string | undefined> = {};
    const override = sessionDir.trim();
    if (override.length > 0) env[PI_SESSION_DIR_ENV] = override;
    return { home: home.trim(), env };
  },
  async listDirectories(path: string): Promise<PiDirectoryEntry[]> {
    const connection = liveConnectionRef();
    const requestId = nextRequestId();
    const result = await sshCapability.sftpList({ ...connection, requestId, path });
    if (result.requestId !== requestId) throw new Error('SFTP listing returned a stale request.');
    return result.entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => ({ name: entry.name, path: entry.path }))
      .sort((left, right) => left.name.localeCompare(right.name));
  },
};

/* ------------------------------------------------------------ attachments */

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * The composer's attach surface (#2857): SAF pick, then SFTP staging into
 * `~/.pocketshell/attachments/<scope>/`.
 *
 * `connectionRef` reads the controller's snapshot at the moment of USE, never a
 * cached ref: the native side rejects a generation that is no longer live, so a
 * reconnect mid-upload fails loudly instead of writing into a stale session.
 * `home` reuses the Pi probe (`remoteContext`), which is the only place this
 * shell already asks the host for `$HOME`; a failed probe returns null and the
 * stager reports it rather than guessing a path.
 */
const attachmentPort = createAndroidAttachmentPort({
  picker: platformInput,
  capability: sshCapability,
  connectionRef: () => {
    const value = snapshot.value;
    return value?.connectionId && value.generationId
      ? { connectionId: value.connectionId, generationId: value.generationId }
      : null;
  },
  home: async () => {
    try {
      const context = await piLiveImplementation.remoteContext();
      return context.home === '' ? null : context.home;
    } catch {
      return null;
    }
  },
});

const composerAttachImplementation: ComposerAttachLive = {
  async attach({ scopeKey, onProgress }) {
    let handles: string[];
    try {
      handles = await attachmentPort.pickFiles({ multiple: true });
    } catch (error) {
      return { paths: [], error: messageOf(error) };
    }
    // A cancelled picker is not a failure: the user closed it, and an error
    // line under an untouched draft would be noise.
    if (handles.length === 0) return { paths: [], error: null };
    const result = await attachmentPort.stage({
      connectionId: snapshot.value?.connectionId ?? '',
      scopeKey,
      sources: handles.map((path) => ({ kind: 'file' as const, path })),
      ...(onProgress === undefined
        ? {}
        : {
            onProgress: (progress: {
              fileName: string;
              fileIndex: number;
              fileCount: number;
              batchBytesWritten: number;
              batchBytesTotal: number;
            }) => onProgress({
              fileName: progress.fileName,
              fileIndex: progress.fileIndex + 1,
              fileCount: progress.fileCount,
              batchBytesWritten: progress.batchBytesWritten,
              batchBytesTotal: progress.batchBytesTotal,
            }),
          }),
    });
    return { paths: result.paths, error: result.ok ? null : result.error ?? null };
  },
};

/* ---------------------------------------------------------- turn PTY */

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

/**
 * A turn's own PTY (R18.3): never the terminal screen's attach PTY or its
 * single `onData` slot. It runs `pi --session <file>` in the chat's project
 * directory and keeps its own read pump and UTF-8 decoder.
 */
const turnPtyImplementation: TurnPtyOpener = {
  async open(command, geometry) {
    const connection = liveConnectionRef();
    const requestId = nextRequestId();
    const opened = await sshCapability.openPty({
      ...connection,
      requestId,
      command,
      cols: geometry.cols,
      rows: geometry.rows,
      term: TURN_TERM,
    });
    if (!isSshResponseFor(opened, requestId, connection)) {
      await sshCapability.closePty({ ...opened, requestId: nextRequestId() }).catch(() => undefined);
      throw new Error('发送通道未能打开。');
    }

    const pty = {
      connectionId: opened.connectionId,
      generationId: opened.generationId,
      channelId: opened.channelId,
    };
    const listeners = new Set<(chunk: string) => void>();
    const turnDecoder = createTerminalTextDecoder();
    let closed = false;
    let readSequence = 0;
    let writeSequence = 0;
    let writeQueue: Promise<void> = Promise.resolve();

    void (async () => {
      while (!closed) {
        const readRequestId = nextRequestId();
        let result;
        try {
          result = await sshCapability.readPty({
            ...pty,
            requestId: readRequestId,
            sequence: readSequence,
            maxBytes: TURN_PTY_MAX_BYTES,
            waitMs: TURN_PTY_WAIT_MS,
          });
        } catch {
          return;
        }
        if (closed) return;
        if (result.channelId !== pty.channelId || !isSshResponseFor(result, readRequestId, pty)) {
          return;
        }
        if (result.sequence === readSequence + 1) {
          readSequence = result.sequence;
          if (result.dataBase64.length > 0) {
            const chunk = turnDecoder.decode(decodeBase64Bytes(result.dataBase64));
            for (const listener of listeners) listener(chunk);
          }
        } else if (result.sequence !== readSequence) {
          return;
        }
        if (result.eof) return;
      }
    })();

    return {
      onData(callback) {
        listeners.add(callback);
        return () => { listeners.delete(callback); };
      },
      write(data) {
        const payload = encodeBase64Bytes(encoder.encode(data));
        // The seam's write is fire-and-forget; queue so two writes never race
        // their sequence, and let the runner's poll report a failed turn.
        writeQueue = writeQueue.then(async () => {
          if (closed) return;
          writeSequence += 1;
          const writeRequestId = nextRequestId();
          const result = await sshCapability.writePty({
            ...pty,
            requestId: writeRequestId,
            sequence: writeSequence,
            dataBase64: payload,
          });
          if (result.sequence !== writeSequence || !isSshResponseFor(result, writeRequestId, pty)) {
            throw new Error('发送通道拒绝了输入。');
          }
        }).catch(() => undefined);
      },
      close() {
        if (closed) return;
        closed = true;
        listeners.clear();
        void sshCapability.closePty({ ...pty, requestId: nextRequestId() }).catch(() => undefined);
      },
    };
  },
};

/* --------------------------------------------------------- trust answers */

/**
 * After a trust accept the dial is live, but the connections store recorded the
 * original dial as failed. Re-ask it for the same saved host: the port answers
 * from the controller it already holds, so no second dial happens.
 */
async function markStoreConnected(): Promise<void> {
  const target = dialedTarget;
  if (!target) return;
  const host = connections.hosts.find(
    (candidate) => candidate.hostname === target.hostname
      && candidate.port === target.port
      && candidate.user === target.username,
  );
  if (host) await connections.connect(host.name);
}

async function decideHostKey(choice: HostKeyTrustChoice): Promise<void> {
  const decision = trustDecision.value;
  const active = controller;
  if (!decision || !active) return;
  const answer = hostKeyAnswer(decision, choice);
  if (answer === 'reject') {
    connectionMessage.value = hostKeyRefusalMessage(decision);
    await connections.disconnect();
    return;
  }
  const result = await active.acceptPresentedHostKey({
    passphrase: activePassphrase,
    persist: answer === 'accept-always',
  });
  activePassphrase = undefined;
  if (!result.ok) {
    connectionMessage.value = result.message;
    return;
  }
  connectionMessage.value = '';
  installSeams();
  await active.refreshSessions().catch(() => null);
  await markStoreConnected();
}

/* ------------------------------------------------- keyboard / safe areas */

let keyboardInsetsStateSync: ReturnType<typeof createKeyboardInsetsStateSync> | undefined;
let removeKeyboardInsetsListener: (() => void) | undefined;
let removeKeyboardViewportListeners: (() => void) | undefined;
let nativeKeyboardInsetsSupported = false;

function updateKeyboardViewport(): void {
  if (nativePlatform !== 'android') return;
  if (nativeKeyboardInsetsSupported) {
    keyboardInsetsStateSync?.refresh();
    return;
  }
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  keyboardVisible.value = window.screen.height - viewportHeight > 150;
}

function applyKeyboardInsets(state: KeyboardInsetsState): void {
  if (!state.supported || !Number.isFinite(state.safeBottomDp) || state.safeBottomDp < 0) {
    nativeKeyboardInsetsSupported = false;
    updateKeyboardViewport();
    return;
  }
  nativeKeyboardInsetsSupported = true;
  keyboardVisible.value = state.imeVisible;
  document.documentElement.style.setProperty(
    '--safe-area-inset-bottom',
    `${state.imeVisible ? 0 : state.safeBottomDp}px`,
  );
}

/**
 * The cold-start twin of the return-to-foreground reconnect: Android recycles
 * a backgrounded process long before the user notices, and a recycled process
 * comes back with no controller, no grace deadline and no memory of the host
 * it was on — `returnToForeground` has nothing to resume, which is why the
 * phone used to land on the host list and wait for a tap. This dials the
 * remembered host once per launch, and only ever once: a dial that fails,
 * hangs at a host-key prompt or is cancelled stays cancelled until the next
 * launch, so a host that cannot be reached cannot trap the user in a loop.
 */
async function attemptLaunchReconnect(): Promise<void> {
  const decision = decideLaunchReconnect({
    lastHost: sharedSettings.defaultHost,
    hostNames: connections.hosts.map((host) => host.name),
    attempted: launchReconnectAttempted(),
    connected: connections.activeName !== null,
  });
  if (decision.action !== 'connect') {
    console.error('[launch-reconnect] skip', decision.reason);
    return;
  }
  console.error('[launch-reconnect] dial', decision.name);
  markLaunchReconnectAttempted();
  await connections.connect(decision.name);
}

/**
 * Wait for the saved hosts before deciding: they arrive from a dynamic import
 * (`useConnectionsStore`), so a mount that beats the import must decide again
 * when the list lands rather than latch on an empty list.
 */
function watchLaunchReconnect(): () => void {
  const stop = watch(
    () => connections.hosts.length,
    (count) => {
      if (count === 0) return;
      stop();
      void attemptLaunchReconnect().catch((error: unknown) => {
        console.error('Could not restore the last SSH connection.', error);
      });
    },
    { immediate: true },
  );
  return () => stop();
}

onMounted(() => {
  installConnectionPort(connectionPort);
  installBackNavigation(backNavigationOwner);
  stopLaunchReconnectWatch = watchLaunchReconnect();
  // The live theme (设置 tab): the boot in main.ts painted the saved choice;
  // this keeps re-picks and OS dark-mode flips applied without a restart.
  stopThemeSync = installThemeSync(document.documentElement);
  stopLocaleSync = installLocaleSync(document.documentElement);
  removeBackButton = installBackButton({
    app: CapacitorApp,
    onError: (error) => {
      console.error('Could not register the Android Back handler.', error);
    },
  });
  disposeAppStateLifecycle = installAppStateLifecycle({
    app: CapacitorApp,
    getController: () => controller,
    // Phone constants, not the shared settings store: without background
    // keep-alive the window is best-effort, and both recover paths are on.
    getBackgroundGraceMs: () => MOBILE_BACKGROUND_GRACE_MS,
    getReconnectOnReturn: () => MOBILE_RECONNECT_ON_RETURN,
    onError: (error) => {
      connectionMessage.value = error instanceof Error ? error.message : String(error);
    },
  });
  keyboardInsetsStateSync = createKeyboardInsetsStateSync(
    () => keyboardInsets.getState(),
    applyKeyboardInsets,
    (error) => console.error('Could not refresh the Android IME insets.', error),
  );
  updateKeyboardViewport();
  window.visualViewport?.addEventListener('resize', updateKeyboardViewport);
  window.addEventListener('resize', updateKeyboardViewport);
  removeKeyboardViewportListeners = () => {
    window.visualViewport?.removeEventListener('resize', updateKeyboardViewport);
    window.removeEventListener('resize', updateKeyboardViewport);
  };

  if (nativePlatform === 'android') {
    void keyboardInsets.addListener('imeInsetsChanged', () => {
      // An invalidation signal: the payload may predate the native state.
      keyboardInsetsStateSync?.refresh();
    }).then((listener) => {
      removeKeyboardInsetsListener = () => { void listener.remove(); };
      keyboardInsetsStateSync?.refresh();
    }).catch((error: unknown) => {
      console.error('Could not register the Android IME inset listener.', error);
    });
  }
});

onBeforeUnmount(() => {
  stopLaunchReconnectWatch?.();
  stopThemeSync?.();
  stopLocaleSync?.();
  removeKeyboardViewportListeners?.();
  keyboardInsetsStateSync?.dispose();
  removeKeyboardInsetsListener?.();
  removeBackButton?.();
  disposeAppStateLifecycle?.();
  installBackNavigation(null);
  sessions.disposeTurnRunner();
  installTurnPtyOpener(null);
  void closeController();
});
</script>

<template>
  <div
    class="app-shell phone-shell"
    data-testid="phone-shell"
    :data-route="activeTab"
    :data-native-platform="nativePlatform"
    :data-keyboard-visible="keyboardVisible"
    :data-ssh-phase="snapshot?.phase ?? 'idle'"
  >
    <p v-if="connectionMessage" class="phone-shell__message" role="alert" data-testid="phone-shell-message">
      {{ connectionMessage }}
    </p>

    <div class="phone-shell__content" :class="{ 'phone-shell__content--chat': sessions.open !== null }">
      <ConnectionsList
        v-show="activeTab === 'connections'"
        :editor-open="connectionView !== null"
        :keys-open="connectionView === 'keys'"
        @update:editor-open="setEditorOpen"
        @update:keys-open="setKeysOpen"
      />
      <ProjectsList v-show="activeTab === 'projects'" @open="openProjectSessions" />
      <SettingsTab v-show="activeTab === 'settings'" />
      <ChatScreen
        v-show="activeTab === 'sessions' && sessions.open !== null"
        :commands-open="chatCommandsOpen"
        @update:commands-open="setChatCommandsOpen"
      />
      <SessionList v-show="activeTab === 'sessions' && sessions.open === null" />
    </div>

    <!-- A conversation owns the whole screen: the tab bar hides while a chat
         is open, and the chat's own back button (or Android Back) returns to
         the 会话 list. -->
    <AppTabBar v-if="sessions.open === null" v-model="activeTab" />

    <div v-if="trustCard" class="phone-shell__trust" data-testid="phone-shell-trust">
      <HostKeyTrustPrompt
        :request="trustCard.request"
        :trusted-fingerprint-sha256="trustCard.trustedFingerprintSha256"
        @decide="decideHostKey"
      />
    </div>
  </div>
</template>

<style scoped>
.phone-shell {
  position: relative;
}

.phone-shell__content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  padding-bottom: 56px;
  overflow: hidden;
}

/* With the tab bar hidden behind an open chat, its 56px clearance is dead
   space; the shell's own safe-area padding still seats the composer above the
   Android navigation bar. */
.phone-shell__content--chat {
  padding-bottom: 0;
}

.phone-shell__content > * {
  min-height: 0;
}

.phone-shell__message {
  position: fixed;
  inset-inline: var(--sp-3);
  top: calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + var(--sp-3));
  z-index: 25;
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.phone-shell__trust {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  padding: var(--sp-4);
}
</style>
