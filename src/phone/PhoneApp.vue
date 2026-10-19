<script setup lang="ts">
/**
 * The single phone shell (#2936, D42): one root mounted by `src/main.ts`.
 *
 * It owns the active tab, the three tab views, the live connection, and the
 * terminal secondary screen. The connection itself is the repo-local
 * `ConnectionController` bound to the Capacitor SSH capability; this shell
 * hands it to the rest of the app only through the narrow seams the stores and
 * the terminal screen consume (`installConnectionPort`, `installPiLive`,
 * `installTerminalPty`) and takes them back on disconnect/unmount.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import {
  fromAndroidTrustedHostKeySha256,
  type ConnectionSnapshot,
  type HostKeyTrustChoice,
  type HostKeyTrustPin,
  type HostKeyTrustStore,
  type SessionRow,
  type SshHostTarget,
} from '@pocketshell/core';
import HostKeyTrustPrompt from '@ui/app/components/HostKeyTrustPrompt.vue';
import AppTabBar, { type PhoneTab } from '../components/shell/AppTabBar.vue';
import ConnectionsList from '../components/connections/ConnectionsList.vue';
import ProjectsList from '../components/projects/ProjectsList.vue';
import SessionList from '../components/sessions/SessionList.vue';
import ChatScreen from '../components/sessions/ChatScreen.vue';
import TerminalScreen from '../components/terminal/TerminalScreen.vue';
import { ConnectionController } from '../session/connectionController';
import { hostKeyAnswer, hostKeyCard, hostKeyRefusalMessage } from '../session/hostKeyCard';
import { installConnectionPort, type ConnectionPort } from '../session/connectionPort';
import {
  installPiLive,
  type PiDirectoryEntry,
  type PiLive,
  type PiRemoteContext,
} from '../session/piLive';
import { installTerminalPty, type TerminalPty } from '../session/terminalPty';
import { createPiTransport } from '../pi/piTransport';
import { PI_SESSION_DIR_ENV } from '../pi/sessionRoot';
import { projectBasename, useSessionsStore } from '../stores/sessions';
import { useConnectionsStore } from '../stores/connections';
import { sshCapability } from '../native/sshCapability';
import { keyboardInsets, type KeyboardInsetsState } from '../native/keyboardInsets';
import { createKeyboardInsetsStateSync } from '../native/keyboardInsetsState';
import type { TerminalGeometry } from '../terminalGeometry';

const EXEC_TIMEOUT_MS = 15_000;
const nativePlatform = Capacitor.getPlatform();

const activeTab = ref<PhoneTab>('connections');
const sessions = useSessionsStore();
const connections = useConnectionsStore();

const snapshot = ref<ConnectionSnapshot | null>(null);
const keyboardVisible = ref(false);
const connectionMessage = ref('');
const terminalTarget = ref<{ name: string; title: string } | null>(null);

let controller: ConnectionController | null = null;
let dialedTarget: SshHostTarget | null = null;
let removeControllerSnapshot: (() => void) | undefined;
let removeTerminalOutput: (() => void) | undefined;
let terminalDataHandler: ((data: string) => void) | null = null;
/** Output that landed between `attach()` and the screen's `onData()` registration. */
let pendingTerminalOutput = '';
let attachedSession: SessionRow | null = null;
let activePassphrase: string | undefined;
let requestSequence = 0;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/* ------------------------------------------------------------------ trust */

function pinStoreKey(hostId: string): string {
  return `pocketshell.ssh.host-key.${hostId}`;
}

/** The legacy phone's stored pin, including the bare-fingerprint Android rows. */
function readStoredPin(hostId: string): HostKeyTrustPin | null {
  const stored = localStorage.getItem(pinStoreKey(hostId));
  if (stored == null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed === 'string') return fromAndroidTrustedHostKeySha256(parsed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const pin = parsed as Record<string, unknown>;
    if (pin.kind === 'sha256-fingerprint' && typeof pin.fingerprintSha256 === 'string') {
      return { kind: 'sha256-fingerprint', fingerprintSha256: pin.fingerprintSha256 };
    }
    if (
      pin.kind === 'wire-key'
      && typeof pin.fingerprintSha256 === 'string'
      && typeof pin.keyType === 'string'
      && typeof pin.keyB64 === 'string'
    ) {
      return {
        kind: 'wire-key',
        fingerprintSha256: pin.fingerprintSha256,
        keyType: pin.keyType,
        keyB64: pin.keyB64,
      };
    }
    return null;
  } catch {
    // Older Android host rows store the SHA256 fingerprint as a bare string.
    return fromAndroidTrustedHostKeySha256(stored);
  }
}

const trustStore: HostKeyTrustStore = {
  async get(hostId) {
    return readStoredPin(hostId);
  },
  async record(hostId, pin) {
    localStorage.setItem(pinStoreKey(hostId), JSON.stringify(pin));
  },
};

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

function sameSessionRow(left: SessionRow, right: SessionRow): boolean {
  if (left.id && right.id) return left.id === right.id;
  return left.name === right.name && left.workspace === right.workspace;
}

function findSessionRow(rows: readonly SessionRow[], name: string): SessionRow | null {
  return rows.find((row) => row.name === name) ?? null;
}

function bindController(next: ConnectionController): void {
  removeControllerSnapshot?.();
  removeTerminalOutput?.();
  controller = next;
  removeControllerSnapshot = next.subscribe((value) => {
    snapshot.value = value;
  });
  removeTerminalOutput = next.subscribeTerminalOutput((session, bytes) => {
    // The terminal screen shows one PTY: only the attached session's bytes.
    if (!attachedSession || !sameSessionRow(attachedSession, session)) return;
    const chunk = decoder.decode(bytes);
    if (terminalDataHandler) terminalDataHandler(chunk);
    else pendingTerminalOutput += chunk;
  });
}

function releaseSeams(): void {
  installPiLive(null);
  installTerminalPty(null);
}

function installSeams(): void {
  installPiLive(piLiveImplementation);
  installTerminalPty(terminalPtyImplementation);
}

async function closeController(): Promise<void> {
  removeControllerSnapshot?.();
  removeControllerSnapshot = undefined;
  removeTerminalOutput?.();
  removeTerminalOutput = undefined;
  const active = controller;
  controller = null;
  dialedTarget = null;
  attachedSession = null;
  terminalDataHandler = null;
  pendingTerminalOutput = '';
  snapshot.value = null;
  terminalTarget.value = null;
  releaseSeams();
  if (active) await active.close().catch(() => undefined);
}

const USABLE_PHASES = new Set(['connected', 'listing', 'attaching', 'live']);

const connectionPort: ConnectionPort = {
  async connect(target) {
    // A re-request for the host this shell already holds (the connections
    // store re-dials after a host-key accept) must not close and redial it.
    if (
      controller
      && dialedTarget?.hostId === target.hostId
      && USABLE_PHASES.has(controller.getSnapshot().phase)
    ) {
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
    async sftpRead({ path, maxBytes }) {
      const connection = liveConnectionRef();
      const requestId = nextRequestId();
      const result = await sshCapability.sftpRead({ ...connection, requestId, path, maxBytes });
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

/* ---------------------------------------------------------- terminal seam */

const terminalPtyImplementation: TerminalPty = {
  async attach(sessionName, geometry: TerminalGeometry) {
    const active = controller;
    if (!active) return { ok: false, error: '请先连接' };
    let row = findSessionRow(active.getSnapshot().sessions, sessionName);
    if (!row) {
      const listing = await active.refreshSessions();
      if (!listing.ok) return { ok: false, error: listing.message };
      row = findSessionRow(active.getSnapshot().sessions, sessionName);
    }
    if (!row) return { ok: false, error: `找不到会话「${sessionName}」` };
    const result = await active.attachSession(row, geometry);
    if (!result.ok) return { ok: false, error: result.message };
    attachedSession = result.value;
    pendingTerminalOutput = '';
    return { ok: true };
  },
  onData(callback) {
    terminalDataHandler = callback;
    // The PTY may have painted before the screen registered its pump; hand
    // that first output over now rather than dropping the attach banner.
    if (pendingTerminalOutput.length > 0) {
      const chunk = pendingTerminalOutput;
      pendingTerminalOutput = '';
      callback(chunk);
    }
  },
  async write(data) {
    if (!controller || !attachedSession) return;
    const result = await controller.writeTerminalBytes(attachedSession, encoder.encode(data));
    if (!result.ok) throw new Error(result.message);
  },
  async resize(cols, rows) {
    if (!controller || !attachedSession) return;
    const result = await controller.resizeTerminal(attachedSession, cols, rows);
    if (!result.ok) throw new Error(result.message);
  },
  async detach() {
    const active = controller;
    const row = attachedSession;
    attachedSession = null;
    terminalDataHandler = null;
    pendingTerminalOutput = '';
    if (active && row) await active.detachSession(row).catch(() => undefined);
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

/* -------------------------------------------------------- terminal screen */

function openTerminal(path: string): void {
  // v1 mapping, flagged for dogfood sign-off: the aplexer session name is the
  // workspace folder's basename, not a resolved host-session lookup.
  const name = projectBasename(path);
  if (name.length === 0) return;
  terminalTarget.value = { name, title: name };
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

onMounted(() => {
  installConnectionPort(connectionPort);
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
  removeKeyboardViewportListeners?.();
  keyboardInsetsStateSync?.dispose();
  removeKeyboardInsetsListener?.();
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

    <div class="phone-shell__content">
      <ConnectionsList v-if="activeTab === 'connections'" />
      <ProjectsList v-else-if="activeTab === 'projects'" @open-terminal="openTerminal" />
      <template v-else>
        <ChatScreen v-if="sessions.open !== null" @open-terminal="openTerminal" />
        <SessionList v-else />
      </template>
    </div>

    <AppTabBar v-model="activeTab" />

    <div v-if="trustCard" class="phone-shell__trust" data-testid="phone-shell-trust">
      <HostKeyTrustPrompt
        :request="trustCard.request"
        :trusted-fingerprint-sha256="trustCard.trustedFingerprintSha256"
        @decide="decideHostKey"
      />
    </div>

    <div v-if="terminalTarget" class="phone-shell__terminal">
      <TerminalScreen
        :session-name="terminalTarget.name"
        :title="terminalTarget.title"
        @close="terminalTarget = null"
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

.phone-shell__terminal {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: var(--bg);
}
</style>
