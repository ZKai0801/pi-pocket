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
 * Host switching (D8): every in-flight run is keyed to the host it was
 * claimed on, and the host is re-read at write time — a run whose host
 * changes under it (or that a newer claim supersedes) drops its writes, so a
 * stale host's list or chat never renders. The wrapper's host-switch watch
 * invalidates the in-flight runs (`hostChanged()`) and clears the state; it
 * also loads the session list when the projects tab selects a project.
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
  /** Lists `project`'s sessions. Joins the in-flight run only for the same host and project; otherwise claims fresh. */
  load(project: PiProject): Promise<void>;
  /** Reads `path` into `open`. Joins the in-flight run only for the same host and path; a failure leaves the previous `open` intact. */
  openSession(path: string): Promise<void>;
  /** Re-reads the open session, or reloads the last project, or does nothing. */
  refresh(): Promise<void>;
  /** Back navigation: clears the open session and its path. */
  closeChat(): void;
  /**
   * Invalidates every in-flight run (D8): their results settle into dropped
   * writes, and nothing may join them any more. The wrapper's host-switch
   * watch calls this in addition to its state clear.
   */
  hostChanged(): void;
}

export interface SessionsStoreDeps {
  listSessions(project: PiProject): Promise<PiSessionMeta[]>;
  readSession(path: string): Promise<ParsedPiSession>;
  /**
   * The active host's name, read at claim time and again at write time (D8):
   * a run captured on one host must not write under another. Defaults to
   * `() => null`, which keeps host-agnostic callers (and the host-less tests)
   * behaving exactly as before.
   */
  hostId?: () => string | null;
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

  // The active host, re-read at write time (D8): a run captured on one host
  // must not write its result under another.
  const hostId = deps.hostId ?? (() => null);

  // Host-keyed re-entrancy (D8, the sessions-side twin of the R10 contract in
  // `projects.ts`): each in-flight run is a claim carrying a monotonically
  // increasing token, the host it was claimed on, and its target. A caller
  // joins the in-flight run only when the context matches (same host, same
  // target); otherwise it claims fresh, and the superseded run's writes are
  // dropped at settlement. One token counter per op family.
  let loadToken = 0;
  let openToken = 0;
  let loadInFlight: { token: number; host: string | null; project: PiProject; promise: Promise<void> } | null = null;
  let openInFlight: { token: number; host: string | null; path: string; promise: Promise<void> } | null = null;

  // Claimed synchronously; the in-flight slot holds only the newest claim —
  // `hostChanged` bumps the tokens AND clears the slots, so a run invalidated
  // this way can never be joined (even if its context matches again).
  function load(project: PiProject): Promise<void> {
    const host = hostId();
    if (
      loadInFlight !== null &&
      loadInFlight.host === host &&
      loadInFlight.project.path === project.path
    ) {
      return loadInFlight.promise;
    }
    const token = ++loadToken;
    loadInFlight = {
      token,
      host,
      project,
      promise: (async () => {
        state.state = 'loading';
        state.error = null;
        try {
          const sessions = await deps.listSessions(project);
          // A newer claim or a host switch made this run stale: drop the
          // write instead of painting a foreign host's or project's list.
          if (loadToken !== token || hostId() !== host) return;
          state.lastProject = project;
          state.sessions = sessions;
          state.state = 'ready';
        } catch (error) {
          if (loadToken !== token || hostId() !== host) return;
          // A failed list is an error, never an empty list masquerading as
          // "no sessions". `lastProject` is written here too, so the list's
          // 重试 button can reload the very project that failed.
          state.lastProject = project;
          state.sessions = [];
          state.state = 'error';
          state.error = errorMessage(error);
        } finally {
          // Only the newest claim may clear the slot: a stale run settling
          // after a fresh claim must not wipe the fresh claim's slot.
          if (loadToken === token) loadInFlight = null;
        }
      })(),
    };
    return loadInFlight.promise;
  }

  // Same treatment for reads, keyed on { host, path }; a failed open keeps
  // the previous chat and path intact (R11.2) — only the state says the
  // re-read failed.
  function openSession(path: string): Promise<void> {
    const host = hostId();
    if (openInFlight !== null && openInFlight.host === host && openInFlight.path === path) {
      return openInFlight.promise;
    }
    const token = ++openToken;
    openInFlight = {
      token,
      host,
      path,
      promise: (async () => {
        state.state = 'loading';
        state.error = null;
        try {
          const session = await deps.readSession(path);
          if (openToken !== token || hostId() !== host) return;
          state.open = session;
          state.openPath = path;
          state.state = 'ready';
        } catch (error) {
          if (openToken !== token || hostId() !== host) return;
          state.state = 'error';
          state.error = errorMessage(error);
        } finally {
          if (openToken === token) openInFlight = null;
        }
      })(),
    };
    return openInFlight.promise;
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

  // D8: called by the wrapper's host-switch watch. Bumping the tokens makes
  // every in-flight run's writes drop at settlement; clearing the slots
  // forces the next claim to be fresh, so an invalidated run is never joined.
  function hostChanged(): void {
    loadToken += 1;
    openToken += 1;
    loadInFlight = null;
    openInFlight = null;
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
    hostChanged,
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
    // D8: claims are keyed to the active host and re-checked at write time,
    // so a run captured on one host cannot write under another.
    hostId: () => useConnectionsStore().activeName,
  });

  // Host switch (D8): the previous host's list and chat are stale the moment
  // the connection changes. Invalidate the in-flight runs first — their
  // results must settle into dropped writes — then clear the state, which is
  // what makes the UI immediately honest.
  const connections = useConnectionsStore();
  watch(
    () => connections.activeName,
    () => {
      store.hostChanged();
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
