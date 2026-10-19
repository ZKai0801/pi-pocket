/**
 * The 会话 tab's store (spec §8.5/§8.6): the selected project's Pi
 * conversations, and the one session open in the read-only chat.
 *
 * `createSessionsStore` takes its dependencies as arguments so it is
 * testable with neither Pinia nor a device; `useSessionsStore` is the thin
 * Pinia wrapper that binds the shell's installed `PiLive` seam, resolving the
 * session root per call (the same shape as the projects wrapper, R11.1):
 * `piLive()` + the active host's per-host `piSessionsDir` override +
 * `resolveSessionRoot`. An uninstalled seam or a `null` root rejects through
 * the dep and lands in `state: 'error'` — the store never throws.
 *
 * Host switching (D8): the wrapper watches the active connection and clears
 * everything, so a stale host's list or chat never renders. It also loads the
 * session list when the projects tab selects a project.
 *
 * Navigation is store-driven (R11.5): the chat shows while `open !== null`,
 * back calls `closeChat()`. The legacy navigation store is not involved.
 */
import { reactive, toRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { PiRepository, type PiProject, type PiSessionMeta } from '../pi/piRepository';
import { resolveSessionRoot } from '../pi/resolveSessionRoot';
import type { ParsedPiSession } from '../pi/types';
import { piLive } from '../session/piLive';
import { useConnectionsStore } from './connections';
import { useProjectsStore } from './projects';

export type SessionsState = 'idle' | 'loading' | 'ready' | 'error';

export interface SessionsStoreState {
  sessions: PiSessionMeta[];
  /** The session open in the chat, or null while the list is showing. */
  open: ParsedPiSession | null;
  /** The open session's file path: `ParsedPiSession` carries no path, and the chat's pull-to-refresh re-reads it. */
  openPath: string | null;
  /** The project `sessions` was loaded for, so `refresh()` can reload it. */
  lastProject: PiProject | null;
  state: SessionsState;
  error: string | null;
}

export interface SessionsStore extends SessionsStoreState {
  /** Lists `project`'s sessions. Re-entrancy-guarded: a second call while one is in flight joins it. */
  load(project: PiProject): Promise<void>;
  /** Reads `path` into `open`. Re-entrancy-guarded; a failure leaves the previous `open` intact. */
  openSession(path: string): Promise<void>;
  /** Re-reads the open session, or reloads the last project, or does nothing. */
  refresh(): Promise<void>;
  /** Back navigation: clears the open session and its path. */
  closeChat(): void;
}

export interface SessionsStoreDeps {
  listSessions(project: PiProject): Promise<PiSessionMeta[]>;
  readSession(path: string): Promise<ParsedPiSession>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The sessions could not be loaded.';
}

/** The last path segment, matching `PiRepository`'s `projectNameFromPath`. */
export function projectBasename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 刚刚 / N 分钟 / N 小时 / N 天, then a date (spec §8.5 relative time). */
export function relativeTime(updatedAtMs: number, nowMs: number = Date.now()): string {
  const age = nowMs - updatedAtMs;
  if (age < MINUTE_MS) return '刚刚';
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} 分钟`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} 小时`;
  if (age < 7 * DAY_MS) return `${Math.floor(age / DAY_MS)} 天`;
  const date = new Date(updatedAtMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createSessionsStore(deps: SessionsStoreDeps): SessionsStore {
  const state = reactive<SessionsStoreState>({
    sessions: [],
    open: null,
    openPath: null,
    lastProject: null,
    state: 'idle',
    error: null,
  });

  let loadInFlight: Promise<void> | null = null;
  let openInFlight: Promise<void> | null = null;

  // Re-entrancy guard (R11.2): a second `load` while one is in flight joins
  // the in-flight run instead of starting a second `listSessions`. Claimed
  // synchronously; released on every exit path.
  function load(project: PiProject): Promise<void> {
    if (loadInFlight) return loadInFlight;
    state.lastProject = project;
    loadInFlight = (async () => {
      state.state = 'loading';
      state.error = null;
      try {
        state.sessions = await deps.listSessions(project);
        state.state = 'ready';
      } catch (error) {
        // A failed list is an error, never an empty list masquerading as
        // "no sessions".
        state.sessions = [];
        state.state = 'error';
        state.error = errorMessage(error);
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  }

  // Same guard for reads; a failed open keeps the previous chat and path
  // intact (R11.2) — only the state says the re-read failed.
  function openSession(path: string): Promise<void> {
    if (openInFlight) return openInFlight;
    openInFlight = (async () => {
      state.state = 'loading';
      state.error = null;
      try {
        const session = await deps.readSession(path);
        state.open = session;
        state.openPath = path;
        state.state = 'ready';
      } catch (error) {
        state.state = 'error';
        state.error = errorMessage(error);
      } finally {
        openInFlight = null;
      }
    })();
    return openInFlight;
  }

  async function refresh(): Promise<void> {
    if (state.openPath !== null) {
      await openSession(state.openPath);
      return;
    }
    if (state.lastProject !== null) {
      await load(state.lastProject);
    }
  }

  function closeChat(): void {
    state.open = null;
    state.openPath = null;
  }

  return reactive({
    get sessions() { return state.sessions; },
    set sessions(value: PiSessionMeta[]) { state.sessions = value; },
    get open() { return state.open; },
    set open(value: ParsedPiSession | null) { state.open = value; },
    get openPath() { return state.openPath; },
    set openPath(value: string | null) { state.openPath = value; },
    get lastProject() { return state.lastProject; },
    set lastProject(value: PiProject | null) { state.lastProject = value; },
    get state() { return state.state; },
    set state(value: SessionsState) { state.state = value; },
    get error() { return state.error; },
    set error(value: string | null) { state.error = value; },
    load,
    openSession,
    refresh,
    closeChat,
  });
}

/**
 * The session root the active host's Pi surface lives in, probed per call
 * (R11.1): the remote $HOME and env only the live connection can answer, plus
 * the active host's per-host override. Throws when there is no live seam or
 * no root — the store turns that into `state: 'error'`, never a crash.
 */
async function resolveActiveSessionRoot(): Promise<string> {
  const live = piLive();
  const context = await live.remoteContext();
  const connections = useConnectionsStore();
  const active = connections.activeName !== null
    ? connections.hosts.find((host) => host.name === connections.activeName)
    : undefined;
  const root = await resolveSessionRoot(live.transport(), context.home, context.env, active?.piSessionsDir);
  if (root === null) {
    throw new Error('No Pi session root was found on this host.');
  }
  return root;
}

export const useSessionsStore = defineStore('sessions', () => {
  const store = createSessionsStore({
    // Bound lazily at call time through the shell's live seam, root re-probed
    // per call (R11.1): with the per-host override that is one `test -d`.
    listSessions: async (project) => {
      const root = await resolveActiveSessionRoot();
      return new PiRepository(piLive().transport(), root).listSessions(project);
    },
    readSession: async (path) => {
      const root = await resolveActiveSessionRoot();
      return new PiRepository(piLive().transport(), root).readSession(path);
    },
  });

  // Host switch (D8): the previous host's list and chat are stale the moment
  // the connection changes — clear them, never render them.
  const connections = useConnectionsStore();
  watch(
    () => connections.activeName,
    () => {
      store.sessions = [];
      store.open = null;
      store.openPath = null;
      store.lastProject = null;
      store.error = null;
      store.state = 'idle';
    },
  );

  // The projects tab's selection is what the 会话 tab lists (spec §8.5); the
  // host-switch watch already clears it, so only a non-null value loads.
  const projects = useProjectsStore();
  watch(
    () => projects.selected,
    (selected) => {
      if (selected === null) return;
      void store.load({ path: selected, name: projectBasename(selected) });
    },
  );

  return {
    sessions: toRef(store, 'sessions'),
    open: toRef(store, 'open'),
    openPath: toRef(store, 'openPath'),
    lastProject: toRef(store, 'lastProject'),
    state: toRef(store, 'state'),
    error: toRef(store, 'error'),
    load: store.load,
    openSession: store.openSession,
    refresh: store.refresh,
    closeChat: store.closeChat,
  };
});
