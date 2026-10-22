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
import {
  PiRepository,
  sessionIdFromPath,
  type PiProject,
  type PiSessionMeta,
} from '../pi/piRepository';
import { sessionPreview } from '../pi/parsePiSession';
import {
  createPiTurnRunner,
  type PiCommandRunResult,
  type PiTurnRunner,
  type PiTurnSendResult,
  type PiTurnStartNewResult,
} from '../pi/piTurnRunner';
import { parseSlashLine } from '../pi/piInteractivity';
import { resolvePiCommand } from '../pi/resolvePiCommand';
import { resolveSessionRoot } from '../pi/resolveSessionRoot';
import type { ParsedPiSession } from '../pi/types';
import { piLive } from '../session/piLive';
import { turnPtyOpener } from '../session/turnPty';
import type { SavedHost } from '../platform/android/hostStore';
import { resolveAndRememberRoot } from '../pi/lastSessionRoot';
import { sessionBackupCache } from '../pi/sessionCache';
import { useConnectionsStore } from './connections';
import { useProjectsStore } from './projects';
import { t } from '../i18n';

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
  /** A turn is being written to Pi and awaited in the open chat. */
  sending: boolean;
  /** The last send failure, already in the UI's language. */
  sendError: string | null;
  /**
   * A note about a send that succeeded: today, a command that ran in a surface
   * this chat cannot show. Never an error — the command did reach pi.
   */
  sendNotice: string | null;
  /** The open chat is a draft: its first send creates the session file. */
  startingNew: boolean;
}

export interface SessionsStore extends SessionsStoreState {
  /** Lists `project`'s sessions. Joins the in-flight run only for the same host and project; otherwise claims fresh. */
  load(project: PiProject): Promise<void>;
  /** Reads `path` into `open`. Joins the in-flight run only for the same host and path; a failure leaves the previous `open` intact. */
  openSession(path: string): Promise<void>;
  /** Re-reads the open session, or reloads the last project, or does nothing. */
  refresh(): Promise<void>;
  /**
   * Opens an empty draft chat for `project`; the first `send` creates the
   * session file and adopts it (spec §8.5). Requires a selected project.
   */
  newConversation(project: PiProject): void;
  /** Back navigation: clears the open session and its path. */
  closeChat(): void;
  /**
   * Sends `text` as one Pi turn in the open chat. Never throws: a turn already
   * running is `'busy'`, and a refused/failed turn is `'error'` with
   * `sendError` set. The composer keeps its text unless this says `'sent'`.
   */
  send(text: string): Promise<'sent' | 'busy' | 'error'>;
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
   * The locally backed-up parse of `path` on `host`, painted while the
   * server's fresh read is in flight so the chat opens instantly. Optional so
   * host-less callers (and the existing tests) keep compiling; a miss or a
   * failure is `null` and the open proceeds from the server read alone.
   */
  loadCachedSession?(host: string | null, path: string): Promise<ParsedPiSession | null>;
  /** Remember a fresh parse for the next cold start. Best-effort: failures are swallowed. */
  saveCachedSession?(host: string | null, path: string, session: ParsedPiSession): Promise<void>;
  /**
   * The active host's name, read at claim time and again at write time (D8):
   * a run captured on one host must not write under another. Defaults to
   * `() => null`, which keeps host-agnostic callers (and the host-less tests)
   * behaving exactly as before.
   */
  hostId?: () => string | null;
  /**
   * The turn runner for the open chat. Optional so host-less callers (and the
   * existing tests) keep compiling; `send` refuses without one.
   */
  runner?: PiTurnRunner;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The sessions could not be loaded.';
}

// The runner reports typed English failures; the chat is Chinese. Ordered:
// "did not become ready" must win over the generic timeout wording it carries,
// and the build's stale error must be recognised before the generic patterns.
const TURN_ERROR_COPY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bchat changed\b|\bsuperseded\b/, t('store.sessionSwitched')],
  [/already running|already in progress|\brunning\b/i, t('store.turnBusy')],
  [/disposed/i, t('store.sessionDisconnected')],
  [/already attached to a session/i, t('store.sessionAlreadyOpen')],
  [/not-sent|not sent/i, t('store.sendFailed')],
  [/not a pi command/i, t('store.sendFailed')],
  [/empty/i, t('store.emptyMessage')],
  [/not become ready|\bready\b/i, t('store.piNotReady')],
  [/new session file/i, t('store.newSessionTimeout')],
  [/timed out|timeout/i, t('store.replyTimeout')],
  [/did not confirm|write/i, t('store.writeFailed')],
  [/opener|installed|live ssh connection/i, t('store.channelNotReady')],
];

/** The Chinese copy for a runner failure; unknown messages pass through. */
export function localiseTurnError(error: string): string {
  for (const [pattern, copy] of TURN_ERROR_COPY) {
    if (pattern.test(error)) return copy;
  }
  return error;
}

/** The last path segment, matching `PiRepository`'s `projectNameFromPath`. */
export function projectBasename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** The list row for a conversation the draft turn just created. */
function adoptedSessionMeta(path: string, session: ParsedPiSession): PiSessionMeta {
  const lastTurn = session.turns[session.turns.length - 1];
  return {
    path,
    id: session.id ?? sessionIdFromPath(path),
    name: session.name,
    updatedAtMs: lastTurn?.timestampMs ?? Date.now(),
    preview: sessionPreview(session),
    turnCount: session.turns.length,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 刚刚 / N 分钟 / N 小时 / N 天, then a date (spec §8.5 relative time). */
export function relativeTime(updatedAtMs: number, nowMs: number = Date.now()): string {
  const age = nowMs - updatedAtMs;
  if (age < MINUTE_MS) return t('time.justNow');
  if (age < HOUR_MS) return t('time.minutes', { count: Math.floor(age / MINUTE_MS) });
  if (age < DAY_MS) return t('time.hours', { count: Math.floor(age / HOUR_MS) });
  if (age < 7 * DAY_MS) return t('time.days', { count: Math.floor(age / DAY_MS) });
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
    sending: false,
    sendError: null,
    sendNotice: null,
    startingNew: false,
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
  let sendToken = 0;
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
    // A different project's sessions replace the last project's: the open chat
    // belongs to the old project and its terminal path, so close it here.
    // Bumping the open token also stops an in-flight read from the old project
    // from writing its session after this switch (D8, the project-side twin).
    if (state.lastProject?.path !== project.path) {
      state.open = null;
      state.openPath = null;
      openToken += 1;
      openInFlight = null;
      // The old project's chat is gone, so its in-flight turn and its failure
      // must go with it: a new project never inherits the last chat's error.
      sendToken += 1;
      state.sending = false;
      state.sendError = null;
      state.sendNotice = null;
      state.startingNew = false;
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

  // Remembering a backup is best-effort: a full disk or a closed IndexedDB
  // must never fail the open or the turn that produced the fresh parse.
  function rememberSession(host: string | null, path: string, session: ParsedPiSession): void {
    if (!deps.saveCachedSession) return;
    void deps.saveCachedSession(host, path, session).catch(() => undefined);
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
        // A cold open paints the local backup first: the chat appears at once
        // and the server's fresh read replaces it the moment it lands (spec
        // §8.6). A refresh of the already-open chat skips this — what is on
        // screen is newer than any backup, and repainting it would flash
        // stale turns. A backup miss leaves the cold-open path unchanged.
        const coldOpen = state.openPath !== path || state.open === null;
        let paintedBackup = false;
        if (coldOpen && deps.loadCachedSession) {
          let backup: ParsedPiSession | null = null;
          try {
            backup = await deps.loadCachedSession(host, path);
          } catch {
            backup = null;
          }
          if (openToken !== token || hostId() !== host) return;
          if (backup !== null) {
            state.open = backup;
            state.openPath = path;
            state.startingNew = false;
            state.error = null;
            state.state = 'ready';
            paintedBackup = true;
          }
        }
        if (!paintedBackup) {
          state.state = 'loading';
          state.error = null;
        }
        try {
          const session = await deps.readSession(path);
          if (openToken !== token || hostId() !== host) return;
          state.open = session;
          state.openPath = path;
          state.startingNew = false;
          state.state = 'ready';
          rememberSession(host, path, session);
        } catch (error) {
          if (openToken !== token || hostId() !== host) return;
          // A painted backup survives a failed re-read (R11.2's twin): the
          // chat stays on screen and only the error bar reports the failure.
          state.state = 'error';
          state.error = errorMessage(error);
        } finally {
          if (openToken === token) openInFlight = null;
        }
      })(),
    };
    return openInFlight.promise;
  }

  // A draft chat is an ordinary empty `ParsedPiSession` with no path yet, so
  // the existing chat surface and composer work unchanged. Any in-flight open
  // or turn belongs to the chat being left and must not paint over the draft.
  function newConversation(project: PiProject): void {
    openToken += 1;
    openInFlight = null;
    sendToken += 1;
    state.sending = false;
    state.startingNew = true;
    state.lastProject = project;
    state.open = { version: 3, id: '', cwd: project.path, name: null, turns: [] };
    state.openPath = null;
    state.sendError = null;
    state.sendNotice = null;
    // A draft is not a list load failure: never show the old error/retry.
    state.state = 'idle';
    state.error = null;
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

  /** Keep the just-created conversation at the top of the project's list. */
  function rememberAdoptedSession(sessionFile: string, session: ParsedPiSession): void {
    const meta = adoptedSessionMeta(sessionFile, session);
    state.sessions = [
      meta,
      ...state.sessions.filter((existing) => existing.path !== sessionFile),
    ];
  }

  // One turn at a time in the open chat (D10). The claim carries the host and
  // path it was made for, and both are re-checked at settlement (D8), so a
  // turn that lands after a host/project/chat switch never paints `open`.
  //
  // A `/command` makes the same claim but completes differently: pi runs it
  // in-process and appends no assistant turn, so the turn's "wait for a new
  // assistant reply" rule would sit on its 120 s timeout over work that had
  // already finished. `runCommand` resolves as soon as pi has the bytes, the
  // transcript is left untouched, and a command that opened a surface this
  // chat cannot render raises `sendNotice` instead of a fake failure.
  async function send(text: string): Promise<'sent' | 'busy' | 'error'> {
    const startingNew = state.startingNew;
    const projectPath = startingNew ? state.open?.cwd ?? null : null;
    const sessionFile = startingNew ? '' : state.openPath;
    if (
      state.open === null ||
      !deps.runner ||
      (startingNew ? projectPath === null : sessionFile === null)
    ) {
      state.sendError = t('store.sendUnavailable');
      return 'error';
    }
    const runner = deps.runner;
    if (runner.isBusy()) return 'busy';
    if (text.trim() === '') {
      state.sendError = t('store.emptyMessage');
      return 'error';
    }
    const slash = parseSlashLine(text);

    const host = hostId();
    const token = ++sendToken;
    state.sending = true;
    state.sendError = null;
    state.sendNotice = null;
    try {
      let result: PiTurnSendResult | null = null;
      let command: PiCommandRunResult | null = null;
      let adoptedFile: string | null = null;
      try {
        if (slash !== null) {
          // A draft runs the command on the sessionless process: nothing has
          // been written yet, so there is no session file to attach to.
          command = startingNew
            ? await runner.runCommand(null, slash.line)
            : await runner.runCommand(sessionFile as string, slash.line);
        } else if (startingNew) {
          // A draft's first turn creates the file; the project directory is
          // part of the claim, so a project switch mid-turn drops the write.
          const created = await runner.startNew(projectPath as string, text);
          if (created.ok) adoptedFile = created.sessionFile;
          result = created;
        } else {
          result = await runner.send(sessionFile as string, text);
        }
      } catch (error) {
        if (slash !== null) {
          command = { ok: false, error: errorMessage(error) };
        } else {
          result = { ok: false, error: errorMessage(error) };
        }
      }
      // A stale claim's turn is abandoned, never shown (D8): the host changed,
      // the chat closed, the draft's project changed, or another project
      // replaced it mid-flight.
      const staleClaim =
        sendToken !== token ||
        hostId() !== host ||
        (startingNew
          ? !state.startingNew ||
            state.open?.cwd !== projectPath ||
            state.openPath !== null
          : state.openPath !== sessionFile);
      if (staleClaim) {
        return 'error';
      }
      if (command !== null) {
        if (!command.ok) {
          state.sendError = localiseTurnError(command.error);
          return 'error';
        }
        if (command.hiddenUi) state.sendNotice = t('store.commandTerminalOnly');
        return 'sent';
      }
      // Every branch above assigns one of the two results.
      if (result === null) return 'error';
      if (result.ok) {
        state.open = result.session;
        if (startingNew) {
          state.openPath = adoptedFile;
          state.startingNew = false;
          // Only the project whose list is loaded may receive the new row;
          // never prepend it to another project's conversations.
          if (adoptedFile !== null && state.lastProject?.path === projectPath) {
            rememberAdoptedSession(adoptedFile, result.session);
          }
        }
        // The turn just wrote the file, so its parse is the freshest backup
        // this chat can have — remember it for the next cold start.
        const rememberedPath = startingNew ? adoptedFile : sessionFile;
        if (rememberedPath !== null) rememberSession(host, rememberedPath, result.session);
        return 'sent';
      }
      state.sendError = localiseTurnError(result.error);
      return 'error';
    } finally {
      if (sendToken === token) state.sending = false;
    }
  }

  function closeChat(): void {
    // Abandon any in-flight turn (D10) and clear the composer's failure so the
    // next chat starts clean; the runner itself is disposed by the wrapper.
    sendToken += 1;
    state.sending = false;
    state.sendError = null;
    state.sendNotice = null;
    state.startingNew = false;
    state.open = null;
    state.openPath = null;
  }

  // D8: called by the wrapper's host-switch watch. Bumping the tokens makes
  // every in-flight run's writes drop at settlement; clearing the slots
  // forces the next claim to be fresh, so an invalidated run is never joined.
  function hostChanged(): void {
    loadToken += 1;
    openToken += 1;
    sendToken += 1;
    state.sending = false;
    state.sendError = null;
    state.sendNotice = null;
    state.startingNew = false;
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
    get sending() { return state.sending; },
    set sending(value: boolean) { state.sending = value; },
    get sendError() { return state.sendError; },
    set sendError(value: string | null) { state.sendError = value; },
    get sendNotice() { return state.sendNotice; },
    set sendNotice(value: string | null) { state.sendNotice = value; },
    get startingNew() { return state.startingNew; },
    set startingNew(value: boolean) { state.startingNew = value; },
    load,
    openSession,
    newConversation,
    refresh,
    closeChat,
    send,
    hostChanged,
  });
}

/**
 * The session root the active host's Pi surface lives in, probed per call
 * (R11.1): the remote $HOME and env only the live connection can answer, plus
 * the active host's per-host override. Throws when there is no live seam or
 * no root — the store turns that into `state: 'error'`, never a crash.
 */
export async function resolveActiveSessionRoot(): Promise<string> {
  const live = piLive();
  const context = await live.remoteContext();
  const connections = useConnectionsStore();
  const active = connections.activeName !== null
    ? connections.hosts.find((host) => host.name === connections.activeName)
    : undefined;
  const root = await resolveAndRememberRoot(
    active?.name,
    () => resolveSessionRoot(live.transport(), context.home, context.env, active?.piSessionsDir),
  );
  if (root === null) {
    throw new Error('No Pi session root was found on this host.');
  }
  return root;
}

const MIN_TURN_POLL_INTERVAL_MS = 250;
const TURN_POLL_INTERVAL_MS = 500;
const BUSY_TURN_ERROR = 'A turn is already running in this chat.';
const STALE_TURN_ERROR = 'The chat changed before the turn could start.';

/** The turn's poll interval, never tighter than the shared floor (R22). */
export function clampTurnPollInterval(requestedMs: number): number {
  return Math.max(MIN_TURN_POLL_INTERVAL_MS, requestedMs);
}

/** Re-read the open session through the live seam, bounded by PiRepository's own exec timeout. */
function readSessionOnActiveHost(path: string): Promise<ParsedPiSession> {
  return readActiveSession(path);
}

async function readActiveSession(path: string): Promise<ParsedPiSession> {
  const root = await resolveActiveSessionRoot();
  return new PiRepository(piLive().transport(), root).readSession(path);
}

/**
 * The project's newest session file, from the existing newest-first session
 * listing (no new shell builder). `null` means the project has none yet.
 */
async function newestSessionFileOnActiveHost(projectPath: string): Promise<string | null> {
  const root = await resolveActiveSessionRoot();
  const sessions = await new PiRepository(piLive().transport(), root).listSessions({
    path: projectPath,
    name: projectBasename(projectPath),
  });
  return sessions.length > 0 ? sessions[0]?.path ?? null : null;
}

/**
 * The local backup of an opened conversation (spec §8.6): the chat paints it
 * instantly on a cold open while the server's fresh read is in flight, and
 * every fresh read or turn re-saves it. Keyed by the claim's host — a session
 * file path alone is not unique across hosts — and backed by IndexedDB with
 * the TTL/LRU sweep in `sessionCache`. Best-effort by contract: the store
 * swallows a failure, so these never reject in practice.
 */
function loadCachedSessionOnActiveHost(host: string | null, path: string): Promise<ParsedPiSession | null> {
  return sessionBackupCache()
    .load(host, path)
    .then((entry) => entry?.session ?? null);
}

function saveCachedSessionOnActiveHost(
  host: string | null,
  path: string,
  session: ParsedPiSession,
): Promise<void> {
  return sessionBackupCache().save(host, path, session);
}

export interface TurnRunnerCacheDeps {
  /** The active host name, read now. */
  hostId: () => string | null;
  /** The open chat's session file, read now. */
  openPath: () => string | null;
  /** The open chat's project directory, read now. */
  projectPath: () => string | null;
  /** Resolve the Pi command for the active host; this probes the shell. */
  resolveCommand: () => Promise<{ ok: true; command: string } | { ok: false; error: string }>;
  /** Build one runner for a resolved command and the claimed project directory. */
  build: (command: string, projectPath: string) => PiTurnRunner;
}

export interface TurnRunnerCache {
  /** The runner for `sessionFile`, built on first use and reused afterwards. */
  runnerFor(sessionFile: string): Promise<PiTurnRunner>;
  /** True while a cached runner is running a turn. */
  isBusy(): boolean;
  /** Forget only the chat's runner; the resolved command outlives the chat. */
  disposeChat(): void;
  /** Forget everything and invalidate every build in flight. */
  dispose(): void;
}

/**
 * One turn runner per host + chat (D10), built behind a probe that can take up
 * to 15 s. Host, chat path and project directory are all captured synchronously
 * at the start of a build and re-checked after every await (D8): a build whose
 * connection or chat changed meanwhile disposes what it built and refuses with
 * the stale error instead of caching a runner bound to the wrong directory.
 */
export function createTurnRunnerCache(deps: TurnRunnerCacheDeps): TurnRunnerCache {
  let cached: { key: string; projectPath: string; runner: PiTurnRunner } | null = null;
  // `resolvePiCommand` probes the shell once per connection, not per chat.
  let cachedCommand: { host: string; command: string } | null = null;
  let generation = 0;

  function disposeChat(): void {
    const previous = cached;
    cached = null;
    previous?.runner.dispose();
  }

  function dispose(): void {
    generation += 1;
    cachedCommand = null;
    disposeChat();
  }

  function claimed(
    started: number,
    host: string | null,
    path: string | null,
    projectPath: string,
  ): boolean {
    // A draft's open path is always null, so the project directory is the only
    // thing that can prove which conversation the build was claimed for.
    return (
      generation === started &&
      deps.hostId() === host &&
      deps.openPath() === path &&
      deps.projectPath() === projectPath
    );
  }

  async function commandFor(
    host: string,
    started: number,
  ): Promise<{ ok: true; command: string } | { ok: false; error: string }> {
    if (cachedCommand !== null && cachedCommand.host === host) {
      return { ok: true, command: cachedCommand.command };
    }
    const resolution = await deps.resolveCommand();
    if (!resolution.ok) return resolution;
    // A probe that lands after disposal or a host switch must not seed the
    // next connection's cache with this host's answer.
    if (generation === started && deps.hostId() === host) {
      cachedCommand = { host, command: resolution.command };
    }
    return resolution;
  }

  async function runnerFor(sessionFile: string): Promise<PiTurnRunner> {
    const started = generation;
    const host = deps.hostId();
    const path = deps.openPath();
    const projectPath = deps.projectPath();
    const key = `${host ?? ''}\n${sessionFile}`;
    // A draft chat has no session path yet; its key is host + '' and the
    // project directory keeps two drafts from sharing a runner.
    const draft = sessionFile === '';
    if (path !== (draft ? null : sessionFile)) throw new Error(STALE_TURN_ERROR);
    if (
      cached !== null &&
      cached.key === key &&
      cached.projectPath === projectPath
    ) {
      return cached.runner;
    }
    if (projectPath === null) throw new Error(t('store.sessionMissingProject'));
    if (cached !== null) disposeChat();

    const command = await commandFor(host ?? '', started);
    if (!claimed(started, host, path, projectPath)) throw new Error(STALE_TURN_ERROR);
    if (!command.ok) throw new Error(command.error);

    const runner = deps.build(command.command, projectPath);
    if (!claimed(started, host, path, projectPath)) {
      runner.dispose();
      throw new Error(STALE_TURN_ERROR);
    }
    cached = { key, projectPath, runner };
    return runner;
  }

  return {
    runnerFor,
    isBusy: () => cached?.runner.isBusy() === true,
    disposeChat,
    dispose,
  };
}

export interface TurnRunnerFacadeDeps {
  runnerFor(sessionFile: string): Promise<PiTurnRunner>;
  disposeChat(): void;
  dispose(): void;
  isBusy(): boolean;
  openPath(): string | null;
  startingNew(): boolean;
}

/**
 * Serialises build + turn before a runner exists (D10) and owns the one
 * draft-specific lifecycle rule: the sessionless `host \n ''` runner is
 * disposed on every `startNew` exit. A failed attempt may already be attached
 * to a file Pi wrote, so reusing it would wait for a different file forever;
 * the store keeps the draft, while the runner never survives an attempt.
 */
export function createTurnRunnerFacade(deps: TurnRunnerFacadeDeps): PiTurnRunner {
  let pendingTurn: Promise<PiTurnSendResult | PiTurnStartNewResult | PiCommandRunResult> | null = null;

  function track<T extends PiTurnSendResult | PiTurnStartNewResult | PiCommandRunResult>(
    run: Promise<T>,
  ): Promise<T> {
    pendingTurn = run;
    const clear = (): void => {
      if (pendingTurn === run) pendingTurn = null;
    };
    void run.then(clear, clear);
    return run;
  }

  function failure(error: unknown): { ok: false; error: string } {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  function send(sessionFile: string, message: string): Promise<PiTurnSendResult> {
    if (pendingTurn !== null) {
      return Promise.resolve({ ok: false, error: BUSY_TURN_ERROR });
    }
    // Only a non-draft chat can send directly; a draft's first turn must go
    // through startNew so its file is adopted.
    if (deps.startingNew() || deps.openPath() !== sessionFile) {
      return Promise.resolve({ ok: false, error: STALE_TURN_ERROR });
    }
    const run = (async (): Promise<PiTurnSendResult> => {
      try {
        const runner = await deps.runnerFor(sessionFile);
        return await runner.send(sessionFile, message);
      } catch (error) {
        return failure(error);
      }
    })();
    return track(run);
  }

  /**
   * A command is serialised with the turns it shares a PTY with, but it is not
   * a turn: it never adopts a session file and never touches the draft. A
   * draft's command runs on the sessionless runner and leaves it in place, so
   * a choice made before the first message (`/model`, `/thinking`) still
   * applies to that message instead of dying with the PTY.
   */
  function runCommand(sessionFile: string | null, command: string): Promise<PiCommandRunResult> {
    if (pendingTurn !== null) {
      return Promise.resolve({ ok: false, error: BUSY_TURN_ERROR });
    }
    const draft = sessionFile === null;
    const claimed = draft
      ? deps.startingNew() && deps.openPath() === null
      : !deps.startingNew() && deps.openPath() === sessionFile;
    if (!claimed) {
      return Promise.resolve({ ok: false, error: STALE_TURN_ERROR });
    }
    const run = (async (): Promise<PiCommandRunResult> => {
      try {
        const runner = await deps.runnerFor(sessionFile ?? '');
        return await runner.runCommand(sessionFile, command);
      } catch (error) {
        return failure(error);
      }
    })();
    return track(run);
  }

  function startNew(projectPath: string, message: string): Promise<PiTurnStartNewResult> {
    if (pendingTurn !== null) {
      return Promise.resolve({ ok: false, error: BUSY_TURN_ERROR });
    }
    if (!deps.startingNew() || deps.openPath() !== null) {
      return Promise.resolve({ ok: false, error: STALE_TURN_ERROR });
    }
    const run = (async (): Promise<PiTurnStartNewResult> => {
      try {
        const runner = await deps.runnerFor('');
        return await runner.startNew(projectPath, message);
      } catch (error) {
        return failure(error);
      } finally {
        // A failure can happen after Pi wrote the file: that sessionless PTY
        // must not survive the attempt, or the retry would wait for another
        // file while Pi stays attached to the adopted one.
        deps.disposeChat();
      }
    })();
    return track(run);
  }

  return {
    send,
    startNew,
    runCommand,
    isBusy: () => pendingTurn !== null || deps.isBusy(),
    dispose: () => deps.dispose(),
  };
}

export const useSessionsStore = defineStore('sessions', () => {
  const connections = useConnectionsStore();

  function activeSavedHost(): SavedHost | undefined {
    const name = connections.activeName;
    return name === null ? undefined : connections.hosts.find((host) => host.name === name);
  }

  const turnRunners = createTurnRunnerCache({
    hostId: () => connections.activeName,
    openPath: () => store.openPath,
    projectPath: () => store.open?.cwd ?? null,
    resolveCommand: async () => {
      const host = activeSavedHost();
      const override = host?.piCommand?.trim();
      return resolvePiCommand(
        piLive().transport(),
        override && override.length > 0 ? override : undefined,
      );
    },
    build: (command, projectPath) =>
      createPiTurnRunner({
        openPty: (commandLine, geometry) => turnPtyOpener().open(commandLine, geometry),
        piCommand: command,
        projectPath,
        // PiRepository bounds its own fallback exec; the turn's overall deadline
        // is the runner's, not a single read's.
        readSession: readSessionOnActiveHost,
        newestSessionFile: newestSessionFileOnActiveHost,
        pollIntervalMs: clampTurnPollInterval(TURN_POLL_INTERVAL_MS),
      }),
  });

  function disposeTurnRunner(): void {
    turnRunners.dispose();
  }

  // Serializes the build + turn before a runner exists: two taps in the same
  // tick must not open two turn PTYs (D10). The factory owns the draft
  // runner's dispose-after-adoption rule.
  const runnerFacade = createTurnRunnerFacade({
    runnerFor: (sessionFile) => turnRunners.runnerFor(sessionFile),
    disposeChat: () => turnRunners.disposeChat(),
    dispose: () => disposeTurnRunner(),
    isBusy: () => turnRunners.isBusy(),
    openPath: () => store.openPath,
    startingNew: () => store.startingNew,
  });

  const store = createSessionsStore({
    // Bound lazily at call time through the shell's live seam, root re-probed
    // per call (R11.1): with the per-host override that is one `test -d`.
    listSessions: async (project) => {
      const root = await resolveActiveSessionRoot();
      return new PiRepository(piLive().transport(), root).listSessions(project);
    },
    readSession: readActiveSession,
    // Instant cold-open paint from the local backup; the server's fresh read
    // replaces it and re-saves. A cache failure is swallowed by the store.
    loadCachedSession: loadCachedSessionOnActiveHost,
    saveCachedSession: saveCachedSessionOnActiveHost,
    // D8: claims are keyed to the active host and re-checked at write time,
    // so a run captured on one host cannot write under another.
    hostId: () => connections.activeName,
    runner: runnerFacade,
  });

  // Host switch (D8): the previous host's list and chat are stale the moment
  // the connection changes. The runner's PTY belongs to that connection too,
  // so abandon it (D10) before clearing the state.
  watch(
    () => connections.activeName,
    () => {
      disposeTurnRunner();
      store.hostChanged();
      store.sessions = [];
      store.open = null;
      store.openPath = null;
      store.lastProject = null;
      store.error = null;
      store.sendError = null;
      store.state = 'idle';
    },
  );

  // Closing a chat or switching projects abandons its runner; the connection
  // (and the resolved pi command) outlives the chat, so keep that cache.
  watch(
    () => store.openPath,
    () => turnRunners.disposeChat(),
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

  function closeChat(): void {
    turnRunners.disposeChat();
    store.closeChat();
  }

  function newConversation(project: PiProject): void {
    // A draft already has `openPath === null`, so the openPath watch cannot
    // see a second `+`; dispose here so its retry/next draft starts fresh.
    turnRunners.disposeChat();
    store.newConversation(project);
  }

  return {
    sessions: toRef(store, 'sessions'),
    open: toRef(store, 'open'),
    openPath: toRef(store, 'openPath'),
    lastProject: toRef(store, 'lastProject'),
    state: toRef(store, 'state'),
    error: toRef(store, 'error'),
    sending: toRef(store, 'sending'),
    sendError: toRef(store, 'sendError'),
    sendNotice: toRef(store, 'sendNotice'),
    startingNew: toRef(store, 'startingNew'),
    load: store.load,
    openSession: store.openSession,
    newConversation,
    refresh: store.refresh,
    closeChat,
    send: store.send,
    disposeTurnRunner,
  };
});
