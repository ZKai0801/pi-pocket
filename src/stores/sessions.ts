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
 *
 * `load()` paints the project's remembered rows (the `loadCachedSessions` dep)
 * before it lists the server, so entering a project after a reconnect shows
 * its conversations at once instead of waiting out one `tail` per session
 * file. `stale` says the rows on screen are that backup, `refreshing` says the
 * listing behind them is still in flight; a sync that fails keeps the painted
 * rows and reports its error beside them rather than replacing a usable list
 * with an empty error screen. Rows that are already on screen are never
 * repainted from the backup: a refresh must not move the list under the
 * user's thumb.
 */
import { computed, reactive, toRef, watch } from 'vue';
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
  type PiTurnBegun,
  type PiTurnQueueResult,
  type PiTurnRunner,
  type PiTurnSendResult,
  type PiTurnStartNewResult,
  type TurnQueueKind,
} from '../pi/piTurnRunner';
import { parseSlashLine } from '../pi/piInteractivity';
import { buildPiCloseCommand, toTurnLine } from '../pi/piTurn';
import { pendingTurns, sweepAnsweredTurns } from '../pi/pendingTurns';
import { resolvePiCommand } from '../pi/resolvePiCommand';
import { resolveSessionRoot } from '../pi/resolveSessionRoot';
import type { ParsedPiSession, PiTurn } from '../pi/types';
import { piLive } from '../session/piLive';
import { turnPtyOpener } from '../session/turnPty';
import type { SavedHost } from '../platform/android/hostStore';
import { resolveAndRememberRoot } from '../pi/lastSessionRoot';
import { sessionBackupCache } from '../pi/sessionCache';
import { sessionListsCache } from '../pi/sessionListCache';
import { useConnectionsStore } from './connections';
import { useProjectsStore } from './projects';
import { t } from '../i18n';

export type SessionsState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * A line typed into the run that is already in flight. Pi writes it to the
 * session file only when it delivers it (a steering line at the next turn
 * boundary, a follow-up once the run has nothing left), so the chat shows it
 * as a ghost of its own until the file proves it landed.
 */
export interface PendingTurn {
  id: string;
  text: string;
  kind: TurnQueueKind;
  /** User turns the session held when this line was typed: it becomes the next one. */
  afterUserTurns: number;
}

/**
 * A model switch this chat recorded itself. The session file is the authority
 * on switches, but it only has one once pi has appended the `model_change`
 * entry — after the PTY write this store already saw acknowledged. The note
 * stands in for that record from the moment the command settles: the divider
 * and the header's model name are on screen with no read in between. Every
 * painted session then drops the notes it has overtaken.
 */
export interface ModelSwitchNote {
  id: string;
  /** The model the switch selected, as the user gave it. */
  to: string;
  /**
   * How many switches the session file held when this note was taken. A parse
   * that records more than this has the switch itself (or a newer one): the
   * note has been overtaken and is dropped.
   */
  baseline: number;
}

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
  /** `sessions` is the local backup, not yet confirmed by a server listing. */
  stale: boolean;
  /** A server listing is in flight behind the rows already on screen. */
  refreshing: boolean;
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
  /**
   * Session files with a turn still running — on this host, in any
   * conversation, whether or not its chat is on screen. Several may run at
   * once: each has its own runner and PTY.
   */
  running: string[];
  /**
   * The open chat's lines that joined its running turn and are not in the
   * session file yet, in the order they were typed. Rendered after `open`'s
   * turns and reconciled away as the file catches up.
   */
  pending: PendingTurn[];
  /**
   * Dividers for model switches the session file has not recorded yet (see
   * {@link ModelSwitchNote}). Rendered after the turns, dropped by the first
   * painted session that overtakes them.
   */
  modelNotes: ModelSwitchNote[];
}

export interface SessionsStore extends SessionsStoreState {
  /** The open chat's conversation still has a turn in flight. */
  readonly openRunning: boolean;
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
   * Sends `text` in the open chat. Never throws.
   *
   * While the chat is idle this is one new Pi turn. While a turn is running it
   * joins that run instead of being refused, and `intent` says how:
   *
   * - omitted (or `'steer'`) — steering: pi delivers it after the current
   *   assistant turn's tool calls and before the next request, so it steers the
   *   work already under way.
   * - `'follow-up'` — queued behind the whole task, delivered when the run has
   *   no tool calls and no steering left.
   *
   * `'sent'` means the line reached Pi, not that the agent has answered: the
   * reply lands later through `running`/`open`, so the composer can clear
   * itself instead of spinning until the answer.
   */
  send(text: string, intent?: TurnQueueKind): Promise<'sent' | 'busy' | 'error'>;
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
   * The locally backed-up list of `project`'s sessions on `host`, painted
   * while the server's listing is in flight so the 会话 tab shows its rows at
   * once. A miss, an empty list or a failure is `null`: the load then starts
   * from the plain `loading` it replaced.
   */
  loadCachedSessions?(host: string | null, projectPath: string): Promise<PiSessionMeta[] | null>;
  /** Remember a fresh listing for the next cold start. Best-effort: failures are swallowed. */
  saveCachedSessions?(
    host: string | null,
    projectPath: string,
    sessions: readonly PiSessionMeta[],
  ): Promise<void>;
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
  /** Pause used by the post-`/model` re-read; injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
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
  [/no running turn/i, t('store.noRunningTurn')],
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

/**
 * How many times the re-read after a `/model` command tries, and the pause
 * before the second attempt. Pi appends the `model_change` entry when it
 * handles the command — after the PTY write this store already saw
 * acknowledged — so the first read almost always has it; the second covers a
 * pi that was mid-repaint when the bytes arrived. A switch that still has not
 * shown up is no failure: the divider belongs to the file, and the next
 * natural read (the reply, a pull-to-refresh) brings it.
 */
const MODEL_SWITCH_REPAINT_READS = 2;
const MODEL_SWITCH_REPAINT_DELAY_MS = 400;

/**
 * The one command whose whole effect is invisible to a chat that reads the
 * session file turn by turn: `/model provider/model` switches the model and
 * appends a `model_change` entry, never a turn, so the chat paints the switch
 * from the command itself and lets the re-read confirm it against the file.
 */
function isModelSwitchCommand(slash: { token: string; argument: string }): boolean {
  return slash.token === '/model' && slash.argument !== '';
}

/** The switches a parse records; a parse from before the field has none. */
function countModelSwitches(session: ParsedPiSession | null): number {
  return session?.modelSwitches?.length ?? 0;
}

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
    stale: false,
    refreshing: false,
    sending: false,
    sendError: null,
    sendNotice: null,
    startingNew: false,
    running: [],
    pending: [],
    modelNotes: [],
  });

  // The active host, re-read at write time (D8): a run captured on one host
  // must not write its result under another.
  const hostId = deps.hostId ?? (() => null);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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

  // The list backup is best-effort in every direction: an unreadable,
  // unwritable or unavailable cache degrades to the plain server listing it
  // replaced. A failure here must never fail the load.
  async function paintSessionCache(host: string | null, project: PiProject): Promise<boolean> {
    if (!deps.loadCachedSessions) return false;
    let cached: PiSessionMeta[] | null = null;
    try {
      cached = await deps.loadCachedSessions(host, project.path);
    } catch {
      cached = null;
    }
    if (cached === null || cached.length === 0) return false;
    state.sessions = cached;
    // The painted rows belong to this project, so the + and the empty text
    // already answer for it while the listing is still in flight.
    state.lastProject = project;
    state.state = 'ready';
    state.error = null;
    state.stale = true;
    return true;
  }

  function rememberSessions(
    host: string | null,
    projectPath: string,
    sessions: readonly PiSessionMeta[],
  ): void {
    if (!deps.saveCachedSessions) return;
    void deps.saveCachedSessions(host, projectPath, sessions).catch(() => undefined);
  }

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
    const switchingProject = state.lastProject?.path !== project.path;
    if (switchingProject) {
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
      state.pending = [];
      state.modelNotes = [];
      // The last project's rows go with it; the backup paints the next
      // project's rows over the empty list instead of leaving them behind.
      state.sessions = [];
      state.stale = false;
    }
    // The backup is only worth painting when the screen has no rows for this
    // project: a refresh or a retry of the list the user is looking at must
    // never repaint older rows under them. Without a cache dep there is no
    // await at all before the listing — the claim stays synchronous, which is
    // what the store's re-entrancy contract (D8) is built on.
    const needsPaint = switchingProject || state.sessions.length === 0;
    const paint = needsPaint && deps.loadCachedSessions
      ? paintSessionCache(host, project)
      : null;
    const token = ++loadToken;
    loadInFlight = {
      token,
      host,
      project,
      promise: (async () => {
        state.error = null;
        // Rows already on screen are never traded for the spinner: only a
        // load that has nothing to show falls back to it.
        const hadRows = state.sessions.length > 0;
        const painted = paint === null ? false : await paint;
        // A newer claim or a host switch made this run stale before the
        // listing even started: drop the paint instead of showing rows the
        // current claim is about to replace.
        if (loadToken !== token || hostId() !== host) return;
        if (!painted && !hadRows) state.state = 'loading';
        state.refreshing = true;
        try {
          const sessions = await deps.listSessions(project);
          // A newer claim or a host switch made this run stale: drop the
          // write instead of painting a foreign host's or project's list.
          if (loadToken !== token || hostId() !== host) return;
          state.lastProject = project;
          state.sessions = sessions;
          state.state = 'ready';
          state.stale = false;
          rememberSessions(host, project.path, sessions);
        } catch (error) {
          if (loadToken !== token || hostId() !== host) return;
          // A failed list is an error, never an empty list masquerading as
          // "no sessions". `lastProject` is written here too, so the list's
          // 重试 button can reload the very project that failed.
          state.lastProject = project;
          if (painted) {
            // Rows are usable, so a failed sync must not trade them for an
            // error screen: the backup stays and the failure is reported in
            // the row above it.
            state.state = 'ready';
            state.stale = true;
            state.error = errorMessage(error);
          } else {
            state.sessions = [];
            state.state = 'error';
            state.error = errorMessage(error);
          }
        } finally {
          if (loadToken === token) {
            state.refreshing = false;
            loadInFlight = null;
          }
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
        // A different conversation's ghosts mean nothing here, and neither do
        // its switch notes; the queued lines and notes of a chat that is
        // merely being re-read stay until the fresh parse proves them gone.
        if (coldOpen) {
          state.pending = [];
          state.modelNotes = [];
        }
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
          reconcilePending(session);
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
    state.pending = [];
    state.modelNotes = [];
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

  /**
   * The row for a conversation whose first turn was just delivered: name it and
   * give it the message as its preview, so the 会话 list shows the new chat
   * running now instead of after the reply. Only the loaded project may receive
   * it — never another project's conversations.
   */
  function rememberStartedSession(sessionFile: string, projectPath: string | null, preview: string): void {
    if (projectPath === null || state.lastProject?.path !== projectPath) return;
    const meta: PiSessionMeta = {
      path: sessionFile,
      id: sessionIdFromPath(sessionFile),
      name: null,
      updatedAtMs: Date.now(),
      preview,
      turnCount: state.open?.turns.length ?? 1,
    };
    state.sessions = [
      meta,
      ...state.sessions.filter((existing) => existing.path !== sessionFile),
    ];
  }

  function markRunning(sessionFile: string): void {
    if (state.running.includes(sessionFile)) return;
    state.running = [...state.running, sessionFile];
  }

  function clearRunning(sessionFile: string): void {
    state.running = state.running.filter((path) => path !== sessionFile);
  }

  function userTurnCount(session: ParsedPiSession | null): number {
    return session?.turns.filter((turn) => turn.role === 'user').length ?? 0;
  }

  /**
   * Drop the ghost lines Pi has written by now. A queued line becomes the next
   * user turn of its chat, so `afterUserTurns + 1` is exactly the count it
   * appears at; anything the file still does not have is still queued.
   */
  function reconcilePending(session: ParsedPiSession): void {
    // A note the file has now recorded itself is the file's to show: the
    // divider moves to the position its entry was appended at, and the
    // header's model name comes from the file from here.
    state.modelNotes = state.modelNotes.filter(
      (note) => note.baseline >= countModelSwitches(session),
    );
    if (state.pending.length === 0) return;
    const users = userTurnCount(session);
    state.pending = state.pending.filter((item) => users < item.afterUserTurns + 1);
  }

  /** The claim a delivered turn was started under, re-checked when it lands. */
  interface TurnClaim {
    host: string | null;
    /** The file the turn runs in: adopted at delivery time for a draft. */
    sessionFile: string;
  }

  /**
   * A turn the server has accepted has finished: paint its parse into the open
   * chat when that chat is still the same conversation, otherwise leave the
   * transcript alone and only keep its list row honest. `running` clears first,
   * so the status is gone before the reply it belonged to appears.
   */
  function completeTurn(claim: TurnClaim, result: PiTurnSendResult): void {
    clearRunning(claim.sessionFile);
    // The run is over — pi drains its queues before settling — so nothing can
    // still be waiting in the transcript. Whatever is left never landed.
    if (state.openPath === claim.sessionFile) state.pending = [];
    // A turn that lands after a host switch is the old connection's (D8): its
    // session file means nothing here, and neither does its failure.
    if (hostId() !== claim.host) return;
    if (!result.ok) {
      if (state.openPath === claim.sessionFile) {
        state.sendError = localiseTurnError(result.error);
      }
      return;
    }
    const session = result.session;
    rememberSession(claim.host, claim.sessionFile, session);
    if (state.sessions.some((meta) => meta.path === claim.sessionFile)) {
      rememberAdoptedSession(claim.sessionFile, session);
    }
    if (state.openPath !== claim.sessionFile) return;
    state.open = session;
    state.state = 'ready';
    state.error = null;
    // The reply's parse is a fresh read of the file: any switch note it has
    // overtaken is the file's own divider from here.
    reconcilePending(session);
  }

  /**
   * Type one more line into the run that is already in flight. No new turn and
   * no new claim: the runner writes it into the live PTY as steering (Enter,
   * delivered at the next turn boundary) or as a follow-up (Alt+Enter, queued
   * behind the whole task), and pi owns the ordering from there.
   */
  async function queueIntoRun(
    runner: PiTurnRunner,
    sessionFile: string,
    text: string,
    kind: TurnQueueKind,
  ): Promise<'sent' | 'busy' | 'error'> {
    const host = hostId();
    const token = ++sendToken;
    state.sending = true;
    state.sendError = null;
    let result: PiTurnQueueResult;
    try {
      result = await runner.queue(sessionFile, text, kind);
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    } finally {
      if (sendToken === token) state.sending = false;
    }

    // The surface a queued line was typed into may be gone (D8): the host
    // changed, or the chat was replaced while the key was being written. The
    // line itself may well have reached Pi, so it is never re-reported as an
    // error the composer would keep the text for.
    const staleClaim =
      sendToken !== token || hostId() !== host || state.openPath !== sessionFile;
    if (!result.ok) {
      if (staleClaim) return 'error';
      state.sendError = localiseTurnError(result.error);
      return 'error';
    }
    if (staleClaim) return 'sent';
    state.pending = [
      ...state.pending,
      {
        id: `pending-${token}`,
        text: toTurnLine(text),
        kind,
        afterUserTurns: userTurnCount(state.open),
      },
    ];
    return 'sent';
  }

  /**
   * Read the session again after a `/model` command and paint what comes back,
   * so the note the command left behind is swapped for the file's own record
   * — same divider, now at the position its `model_change` entry was appended
   * at, and standing whatever the next reply adds after it. `before` is the
   * number of switches the file held when the command was sent: once a read
   * shows more, the file has the switch and there is nothing to wait for.
   *
   * Every write is guarded the way a turn's is (D8): the host the read was
   * claimed on, the chat that is still open, and the send claim that started
   * this — a newer send, a closed chat or a host switch drops the paint,
   * because that parse is nobody's to show.
   */
  async function repaintAfterModelSwitch(sessionFile: string, before: number, token: number): Promise<void> {
    const host = hostId();
    for (let attempt = 0; attempt < MODEL_SWITCH_REPAINT_READS; attempt += 1) {
      if (attempt > 0) await sleep(MODEL_SWITCH_REPAINT_DELAY_MS);
      let session: ParsedPiSession;
      try {
        session = await deps.readSession(sessionFile);
      } catch {
        // A failed read changes nothing on screen; the next natural repaint
        // (the reply, a pull-to-refresh) still brings the divider.
        return;
      }
      if (sendToken !== token || hostId() !== host || state.openPath !== sessionFile) return;
      reconcilePending(session);
      state.open = session;
      state.state = 'ready';
      state.error = null;
      rememberSession(host, sessionFile, session);
      if (countModelSwitches(session) > before) return;
    }
  }

  // One turn at a time in each conversation (D10) — not one in the app: a
  // second chat may send while the first is still waiting for its reply, and a
  // running conversation takes further lines as steering/follow-ups instead of
  // refusing them. The claim carries the host and path it was made for, and
  // both are re-checked when its reply lands (D8), so a turn that settles after
  // a host switch never paints `open`.
  async function send(
    text: string,
    intent?: TurnQueueKind,
  ): Promise<'sent' | 'busy' | 'error'> {
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
    // One delivery at a time in this chat: two taps in the same tick would race
    // for the same PTY. This is about the write, not about the run.
    if (state.sending) return 'busy';
    if (text.trim() === '') {
      state.sendError = t('store.emptyMessage');
      return 'error';
    }
    const slash = parseSlashLine(text);

    // A draft's first line is always a new turn (it has no run to join); after
    // that the conversation's own status decides, and a message typed into a
    // running chat is exactly what pi's steering/follow-up queues are for.
    if (!startingNew && state.running.includes(sessionFile as string)) {
      return queueIntoRun(runner, sessionFile as string, text, intent ?? 'steer');
    }

    const host = hostId();
    const token = ++sendToken;
    state.sending = true;
    state.sendError = null;
    state.sendNotice = null;
    // A `/command` is not a turn: pi handles it in-process and appends no
    // assistant reply, so it never reaches the two-phase path below. It
    // settles as soon as pi has the bytes; a command that opened a surface
    // this chat cannot draw says so through `sendNotice`, not a failure.
    if (slash !== null) {
      let command: PiCommandRunResult;
      try {
        // A draft runs the command on the sessionless process: nothing has
        // been written yet, so there is no session file to attach to.
        command = startingNew
          ? await runner.runCommand(null, slash.line)
          : await runner.runCommand(sessionFile as string, slash.line);
      } catch (error) {
        command = { ok: false, error: errorMessage(error) };
      } finally {
        if (sendToken === token) state.sending = false;
      }
      const staleCommandClaim =
        sendToken !== token ||
        hostId() !== host ||
        (startingNew
          ? !state.startingNew || state.open?.cwd !== projectPath || state.openPath !== null
          : state.openPath !== sessionFile);
      if (staleCommandClaim) return 'error';
      if (!command.ok) {
        state.sendError = localiseTurnError(command.error);
        return 'error';
      }
      if (command.hiddenUi) state.sendNotice = t('store.commandTerminalOnly');
      if (isModelSwitchCommand(slash)) {
        // The argument the user typed IS the model now in effect, so the
        // divider and the header's model name go up with no read in between;
        // the note stands until a painted session overtakes it. A draft has
        // no file to re-read, so an open session also gets the confirmatory
        // read below — the same one the note is waiting on.
        state.modelNotes = [
          ...state.modelNotes,
          {
            id: `model-note-${token}`,
            to: slash.argument,
            baseline: countModelSwitches(state.open),
          },
        ];
        if (!startingNew) {
          // Fire-and-forget: the send settled when pi had the bytes, and the
          // repaint is a follow-on read of the same file. Its own staleness
          // checks decide whether the parse it brings back is still ours.
          void repaintAfterModelSwitch(sessionFile as string, countModelSwitches(state.open), token);
        }
      }
      return 'sent';
    }

    let begun: PiTurnBegun;
    try {
      begun = startingNew
        ? // A draft's first turn creates the file; the project directory is
          // part of the claim, so a project switch mid-turn drops the write.
          await runner.beginStartNew(projectPath as string, text)
        : await runner.beginSend(sessionFile as string, text);
    } catch (error) {
      begun = { ok: false, error: errorMessage(error) };
    } finally {
      if (sendToken === token) state.sending = false;
    }

    // A stale claim's surface is gone (D8): the host changed, the chat closed,
    // the draft's project changed, or another project replaced it mid-flight.
    // The turn itself may still have been delivered, so it is tracked below
    // either way — only the painting is dropped.
    const staleClaim =
      sendToken !== token ||
      hostId() !== host ||
      (startingNew
        ? !state.startingNew ||
          state.open?.cwd !== projectPath ||
          state.openPath !== null
        : state.openPath !== sessionFile);

    if (!begun.ok) {
      // Nothing reached Pi, so there is nothing to track and no chat to
      // report to when the claim is stale.
      if (staleClaim) return 'error';
      state.sendError = localiseTurnError(begun.error);
      return 'error';
    }

    const startedFile = begun.sessionFile;
    const line = toTurnLine(text);
    markRunning(startedFile);

    if (!staleClaim) {
      // The user's own line goes on screen now: the reply is the only thing
      // still in flight, and it lands through `completeTurn`.
      const turns = state.open?.turns ?? [];
      const optimistic: PiTurn = { role: 'user', text: line, timestampMs: Date.now() };
      if (state.open !== null) state.open = { ...state.open, turns: [...turns, optimistic] };
      if (startingNew) {
        // The draft has a file now, so the chat and the list can name it.
        state.openPath = startedFile;
        state.startingNew = false;
        // The draft's switch notes stay: the reply's parse is the first read
        // of the new file, and it drops whichever of them the file itself
        // has recorded (see `reconcilePending`).
        rememberStartedSession(startedFile, projectPath, line);
      }
    }

    const claim: TurnClaim = { host, sessionFile: startedFile };
    const settle = (result: PiTurnSendResult): void => completeTurn(claim, result);
    const failed = (): void =>
      settle({ ok: false, error: 'The turn ended before Pi wrote a reply.' });
    void begun.completed.then(settle, failed);

    // The host is gone, so the turn died with its connection; anything else is
    // a delivered message whose reply is simply still coming.
    return hostId() === host ? 'sent' : 'error';
  }

  function closeChat(): void {
    // A chat that leaves the screen does not end its turn: the reply keeps
    // coming and `running` keeps the 会话 row honest. Only the composer's
    // failure and the chat's ghosts are cleared, so the next chat starts clean.
    sendToken += 1;
    state.sending = false;
    state.sendError = null;
    state.sendNotice = null;
    state.startingNew = false;
    state.open = null;
    state.openPath = null;
    state.pending = [];
    state.modelNotes = [];
  }

  // D8: called by the wrapper's host-switch watch. Bumping the tokens makes
  // every in-flight run's writes drop at settlement; clearing the slots
  // forces the next claim to be fresh, so an invalidated run is never joined.
  // The running turns belong to the old host's PTYs, which the wrapper has
  // already disposed.
  function hostChanged(): void {
    loadToken += 1;
    openToken += 1;
    sendToken += 1;
    state.sending = false;
    state.sendError = null;
    state.sendNotice = null;
    state.startingNew = false;
    state.running = [];
    state.pending = [];
    state.modelNotes = [];
    // The painted rows belong to the old host's root: they are not this
    // host's to show, so neither the backup marker nor its sync survives.
    state.stale = false;
    state.refreshing = false;
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
    get stale() { return state.stale; },
    set stale(value: boolean) { state.stale = value; },
    get refreshing() { return state.refreshing; },
    set refreshing(value: boolean) { state.refreshing = value; },
    get sending() { return state.sending; },
    set sending(value: boolean) { state.sending = value; },
    get sendError() { return state.sendError; },
    set sendError(value: string | null) { state.sendError = value; },
    get sendNotice() { return state.sendNotice; },
    set sendNotice(value: string | null) { state.sendNotice = value; },
    get modelNotes() { return state.modelNotes; },
    set modelNotes(value: ModelSwitchNote[]) { state.modelNotes = value; },
    get startingNew() { return state.startingNew; },
    set startingNew(value: boolean) { state.startingNew = value; },
    get running() { return state.running; },
    set running(value: string[]) { state.running = value; },
    get pending() { return state.pending; },
    set pending(value: PendingTurn[]) { state.pending = value; },
    /** The open chat's conversation still has a turn in flight. */
    get openRunning() {
      return state.openPath !== null && state.running.includes(state.openPath);
    },
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
 * Tear down a conversation's server-side Pi session once its turn has been
 * answered. The kill itself is idempotent — a host without tmux, or a session
 * that already ended, has nothing to kill and still exits 0 — but a transport
 * failure is reported rather than swallowed: both callers keep their record
 * of the turn so the next connection retries the teardown, and neither lets
 * the rejection reach the chat.
 */
function closeTurnSessionOnActiveHost(sessionName: string): Promise<void> {
  return piLive()
    .transport()
    .exec(buildPiCloseCommand(sessionName), 5_000)
    .then(() => undefined);
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
  /**
   * Dispose the cached runner for one conversation. Called once its turn has
   * settled and its chat is no longer on screen — a runner that is still
   * running a turn owns its PTY and is left alone.
   */
  release(sessionFile: string): void;
  /** Dispose every cached runner; the resolved command outlives them. */
  releaseAll(): void;
  /**
   * The connection's transport is gone but its runs are not (a reconnect).
   * Each runner drops its dead PTY handle and keeps its run, so a chat still
   * reports "running" and re-attaches on the next line instead of being
   * disposed — which used to kill the agent on the server (see piTurn.ts).
   */
  rebind(): void;
  /** Forget everything and invalidate every build in flight. */
  dispose(): void;
}

interface CachedRunner {
  sessionFile: string;
  runner: PiTurnRunner;
}

/**
 * One turn runner per host + conversation + project (D10). Several
 * conversations may be running at once — each has its own PTY, and a chat that
 * is not on screen must not lose its runner to the one that is — so the cache
 * is a map, not a single slot. A draft is keyed by its project as well, so two
 * drafts (the one running and the one just opened in another project) never
 * share, or evict, each other.
 *
 * Host, chat path and project directory are all captured synchronously at the
 * start of a build and re-checked after every await (D8): a build whose
 * connection or project changed meanwhile disposes what it built and refuses
 * with the stale error instead of caching a runner bound to the wrong
 * directory.
 */
export function createTurnRunnerCache(deps: TurnRunnerCacheDeps): TurnRunnerCache {
  const runners = new Map<string, CachedRunner>();
  // `resolvePiCommand` probes the shell once per connection, not per chat.
  let cachedCommand: { host: string; command: string } | null = null;
  let generation = 0;

  function keyFor(host: string | null, projectPath: string | null, sessionFile: string): string {
    return `${host ?? ''}\n${projectPath ?? ''}\n${sessionFile}`;
  }

  function release(sessionFile: string): void {
    for (const [key, entry] of [...runners]) {
      if (entry.sessionFile !== sessionFile) continue;
      // A runner that is still running a turn owns its PTY: its turn's own
      // settlement releases it, never a chat switch underneath it.
      if (entry.runner.isBusy()) continue;
      runners.delete(key);
      entry.runner.dispose();
    }
  }

  function releaseAll(): void {
    const entries = [...runners.values()];
    runners.clear();
    for (const entry of entries) entry.runner.dispose();
  }

  function rebind(): void {
    for (const entry of runners.values()) entry.runner.rebind();
  }

  function dispose(): void {
    generation += 1;
    cachedCommand = null;
    releaseAll();
  }

  function claimed(
    started: number,
    host: string | null,
    projectPath: string,
  ): boolean {
    // A draft's open path is always null, so the project directory is the only
    // thing that can prove which conversation the build was claimed for.
    return (
      generation === started &&
      deps.hostId() === host &&
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
    const projectPath = deps.projectPath();
    const key = keyFor(host, projectPath, sessionFile);
    const cached = runners.get(key);
    if (cached !== undefined) return cached.runner;
    if (projectPath === null) throw new Error(t('store.sessionMissingProject'));

    const command = await commandFor(host ?? '', started);
    if (!claimed(started, host, projectPath)) throw new Error(STALE_TURN_ERROR);
    if (!command.ok) throw new Error(command.error);

    const runner = deps.build(command.command, projectPath);
    if (!claimed(started, host, projectPath)) {
      runner.dispose();
      throw new Error(STALE_TURN_ERROR);
    }
    // A concurrent build of the same conversation landed first: keep its
    // runner and drop this one, so one chat never owns two PTYs.
    const raced = runners.get(key);
    if (raced !== undefined) {
      runner.dispose();
      return raced.runner;
    }
    runners.set(key, { sessionFile, runner });
    return runner;
  }

  return { runnerFor, release, releaseAll, rebind, dispose };
}

export interface TurnRunnerFacadeDeps {
  runnerFor(sessionFile: string): Promise<PiTurnRunner>;
  /** Dispose one conversation's runner once its turn has settled. */
  release(sessionFile: string): void;
  /** Hand a transport change to every cached runner (see `TurnRunnerCache.rebind`). */
  rebind(): void;
  dispose(): void;
  openPath(): string | null;
  startingNew(): boolean;
}

/**
 * Serialises build + turn before a runner exists (D10) and owns the one
 * draft-specific lifecycle rule: the sessionless `''` runner is disposed once
 * its turn settles, whatever the outcome. A failed attempt may already be
 * attached to a file Pi wrote, so reusing it would wait for a different file
 * forever; the store keeps the draft, while the runner never survives an
 * attempt.
 *
 * Claims are per conversation, not global: a second conversation may send
 * while the first is still running. A turn's `completed` clears its claim, and
 * a conversation whose chat is no longer open gives its runner back at that
 * point instead of holding a PTY open in the background.
 */
export function createTurnRunnerFacade(deps: TurnRunnerFacadeDeps): PiTurnRunner {
  /**
   * A command is serialised with the turns it shares a PTY with, but it is not
   * a turn: it never adopts a session file and never touches the draft. A
   * draft's command runs on the sessionless runner and leaves it in place, so
   * a choice made before the first message (`/model`, `/thinking`) still
   * applies to that message instead of dying with the PTY.
   */
  async function runCommand(
    sessionFile: string | null,
    command: string,
  ): Promise<PiCommandRunResult> {
    const key = sessionFile ?? '';
    const draft = sessionFile === null;
    if (
      draft
        ? !deps.startingNew() || deps.openPath() !== null
        : deps.startingNew() || deps.openPath() !== sessionFile
    ) {
      return { ok: false, error: STALE_TURN_ERROR };
    }
    const token = claim(key);
    if (token === null) return { ok: false, error: BUSY_TURN_ERROR };
    let runner: PiTurnRunner;
    try {
      runner = await deps.runnerFor(key);
    } catch (error) {
      settle(key, token);
      return failure(error);
    }
    try {
      return await runner.runCommand(sessionFile, command);
    } catch (error) {
      return failure(error);
    } finally {
      // A command settles the moment pi has the bytes: there is no reply to
      // wait for, so its claim ends here rather than with a turn's completion.
      // The draft's runner is deliberately kept — a choice made before the
      // first message only matters if it survives into it.
      settle(key, token);
    }
  }

  const pending = new Map<string, object>();

  function claim(key: string): object | null {
    if (pending.has(key)) return null;
    const token = {};
    pending.set(key, token);
    return token;
  }

  function settle(key: string, token: object): void {
    if (pending.get(key) === token) pending.delete(key);
  }

  function failure(error: unknown): { ok: false; error: string } {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  /** Hand a begun turn's tail to the caller, releasing the claim when it ends. */
  function track(key: string, token: object, begun: PiTurnBegun, onSettled: () => void): PiTurnBegun {
    if (!begun.ok) {
      settle(key, token);
      return begun;
    }
    const done = (): void => {
      settle(key, token);
      onSettled();
    };
    void begun.completed.then(done, done);
    return begun;
  }

  async function beginSend(sessionFile: string, message: string): Promise<PiTurnBegun> {
    // Only a non-draft chat can send directly; a draft's first turn must go
    // through beginStartNew so its file is adopted.
    if (deps.startingNew() || deps.openPath() !== sessionFile) {
      return { ok: false, error: STALE_TURN_ERROR };
    }
    const token = claim(sessionFile);
    if (token === null) return { ok: false, error: BUSY_TURN_ERROR };
    let runner: PiTurnRunner;
    try {
      runner = await deps.runnerFor(sessionFile);
    } catch (error) {
      settle(sessionFile, token);
      return failure(error);
    }
    let begun: PiTurnBegun;
    try {
      begun = await runner.beginSend(sessionFile, message);
    } catch (error) {
      settle(sessionFile, token);
      return failure(error);
    }
    const handed = track(sessionFile, token, begun, () => {
      // Keep the warm PTY only for the chat that is still on screen; a turn
      // that finished in the background gives its runner back.
      if (deps.openPath() !== sessionFile) deps.release(sessionFile);
    });
    if (!handed.ok) deps.release(sessionFile);
    return handed;
  }

  async function beginStartNew(projectPath: string, message: string): Promise<PiTurnBegun> {
    if (!deps.startingNew() || deps.openPath() !== null) {
      return { ok: false, error: STALE_TURN_ERROR };
    }
    const token = claim('');
    if (token === null) return { ok: false, error: BUSY_TURN_ERROR };
    let runner: PiTurnRunner;
    try {
      runner = await deps.runnerFor('');
    } catch (error) {
      settle('', token);
      // The draft's sessionless PTY never survives an attempt.
      deps.release('');
      return failure(error);
    }
    let begun: PiTurnBegun;
    try {
      begun = await runner.beginStartNew(projectPath, message);
    } catch (error) {
      settle('', token);
      deps.release('');
      return failure(error);
    }
    const handed = track('', token, begun, () => deps.release(''));
    if (!handed.ok) deps.release('');
    return handed;
  }

  function send(sessionFile: string, message: string): Promise<PiTurnSendResult> {
    return (async (): Promise<PiTurnSendResult> => {
      const begun = await beginSend(sessionFile, message);
      if (!begun.ok) return begun;
      return begun.completed;
    })();
  }

  /**
   * Add a line to the run already in flight. It takes no claim: the run's own
   * claim (taken by `beginSend`) is what keeps the PTY alive, and pi's queue —
   * not this facade — decides when the line is delivered. Refused when the chat
   * is a draft or another conversation: there is no run to join.
   */
  async function queue(
    sessionFile: string,
    message: string,
    kind: TurnQueueKind,
  ): Promise<PiTurnQueueResult> {
    if (deps.startingNew() || deps.openPath() !== sessionFile) {
      return { ok: false, error: STALE_TURN_ERROR };
    }
    try {
      const runner = await deps.runnerFor(sessionFile);
      return await runner.queue(sessionFile, message, kind);
    } catch (error) {
      return failure(error);
    }
  }

  function startNew(
    projectPath: string,
    message: string,
  ): Promise<PiTurnStartNewResult> {
    return (async (): Promise<PiTurnStartNewResult> => {
      const begun = await beginStartNew(projectPath, message);
      if (!begun.ok) return begun;
      const completed = await begun.completed;
      if (!completed.ok) return completed;
      return { ok: true, sessionFile: begun.sessionFile, session: completed.session };
    })();
  }

  return {
    send,
    startNew,
    runCommand,
    beginSend,
    beginStartNew,
    queue,
    rebind: () => deps.rebind(),
    isBusy: () => pending.size > 0,
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
        closeSession: closeTurnSessionOnActiveHost,
        // The turn's tmux session is killed by its runner, and the runner dies
        // with the app: the record is what lets the next connection close a
        // session that finished while nobody was watching.
        rememberTurn: (turn) => {
          void pendingTurns().remember(connections.activeName, turn);
        },
        forgetTurn: (sessionName) => {
          void pendingTurns().forget(connections.activeName, sessionName);
        },
        pollIntervalMs: clampTurnPollInterval(TURN_POLL_INTERVAL_MS),
      }),
  });

  function disposeTurnRunner(): void {
    turnRunners.dispose();
  }

  /**
   * A reconnect replaced the transport, not the turn. Keep the runners and let
   * each re-attach to the tmux session its agent is still running in — the
   * alternative (disposing them) is what used to kill in-flight work.
   */
  function rebindTurnRunner(): void {
    turnRunners.rebind();
  }

  /**
   * Close the conversations whose turn was answered while this phone was not
   * looking — the case the runner cannot cover, because the runner is gone by
   * then (the app was killed, or the poll's deadline expired offline). The
   * record holds the assistant-turn count that means "answered", and the read
   * is the same one the runner polls, so a run that is still working is left
   * alone. Returns how many sessions were closed; a failure on one record
   * leaves it for the next connection.
   */
  let sweepingPendingTurns = false;
  async function sweepPendingTurns(): Promise<number> {
    const host = connections.activeName;
    // A sweep can be asked for on every generation bump; the reads are SSH
    // round trips, so one in flight covers them all.
    if (host === null || sweepingPendingTurns) return 0;
    sweepingPendingTurns = true;
    try {
      return await sweepAnsweredTurns({
        host,
        list: (target) => pendingTurns().onHost(target),
        readSession: readSessionOnActiveHost,
        kill: closeTurnSessionOnActiveHost,
        forget: (target, sessionName) => pendingTurns().forget(target, sessionName),
      });
    } finally {
      sweepingPendingTurns = false;
    }
  }

  // Serializes the build + turn before a runner exists: two taps in the same
  // tick must not open two turn PTYs (D10). The facade owns the draft runner's
  // dispose-after-settlement rule.
  const runnerFacade = createTurnRunnerFacade({
    runnerFor: (sessionFile) => turnRunners.runnerFor(sessionFile),
    // The cache leaves a runner that is still running its turn alone, so a
    // chat switch never kills a background turn.
    release: (sessionFile) => turnRunners.release(sessionFile),
    rebind: () => turnRunners.rebind(),
    dispose: () => disposeTurnRunner(),
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
    // The list's rows paint from the local backup the same way the chat does
    // (§8.5): keyed by host + project, replaced by the server's listing.
    loadCachedSessions: (host, projectPath) => sessionListsCache().load(host, projectPath),
    saveCachedSessions: (host, projectPath, sessions) =>
      sessionListsCache().save(host, projectPath, sessions),
    // D8: claims are keyed to the active host and re-checked at write time,
    // so a run captured on one host cannot write under another.
    hostId: () => connections.activeName,
    runner: runnerFacade,
  });

  // Host switch (D8): the previous host's list and chat are stale the moment
  // the connection changes. The runner's PTY belongs to that connection too,
  // so abandon it before clearing the state — the turn itself keeps running on
  // the old host's tmux server (D44); only this side stops watching it.
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
      store.stale = false;
      store.refreshing = false;
      store.state = 'idle';
    },
  );

  // Leaving a chat gives its PTY back — unless it is still running, in which
  // case the facade releases it when the reply has landed. The connection (and
  // the resolved pi command) outlives the chat, so that cache is kept.
  watch(
    () => store.openPath,
    (next, previous) => {
      if (previous === null || previous === next) return;
      turnRunners.release(previous);
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

  function closeChat(): void {
    turnRunners.release(store.openPath ?? '');
    store.closeChat();
  }

  function newConversation(project: PiProject): void {
    // A draft already has `openPath === null`, so the openPath watch cannot
    // see a second `+`; release here so its retry/next draft starts fresh.
    turnRunners.release('');
    store.newConversation(project);
  }

  return {
    sessions: toRef(store, 'sessions'),
    open: toRef(store, 'open'),
    openPath: toRef(store, 'openPath'),
    lastProject: toRef(store, 'lastProject'),
    state: toRef(store, 'state'),
    error: toRef(store, 'error'),
    stale: toRef(store, 'stale'),
    refreshing: toRef(store, 'refreshing'),
    sending: toRef(store, 'sending'),
    sendError: toRef(store, 'sendError'),
    sendNotice: toRef(store, 'sendNotice'),
    startingNew: toRef(store, 'startingNew'),
    pending: toRef(store, 'pending'),
    modelNotes: toRef(store, 'modelNotes'),
    running: toRef(store, 'running'),
    openRunning: computed(() => store.openRunning),
    load: store.load,
    openSession: store.openSession,
    newConversation,
    refresh: store.refresh,
    closeChat,
    send: store.send,
    disposeTurnRunner,
    rebindTurnRunner,
    sweepPendingTurns,
  };
});
