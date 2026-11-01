import type { ComposerDeliveryResult } from '@pocketshell/core';
import { createTerminalTextDecoder } from '../phone/terminalText';
import {
  createComposerDeliveryController,
  type PtyWriteAcknowledgement,
} from '../session/composerDelivery';
import type { TurnPtyGeometry, TurnPtyHandle } from '../session/turnPty';
import { countAssistantTurns, isRunAnswered } from './pendingTurns';
import { parsePiSession } from './parsePiSession';
import type { PiSessionWatch } from './piStream';
import { parseSlashLine, takesOverTerminal } from './piInteractivity';
import { buildPiOpenCommand, PI_TURN_CREATED_MARKER, toTurnLine, turnSessionName } from './piTurn';
import {
  commandOutputLines,
  dialogAnswerKeys,
  newPaneLines,
  parseScreenDialog,
  type PiScreenDialog,
  type PiScreenDialogEvent,
} from './piDialog';
import { createConsoleTracker, isPiReady } from './turnReadiness';
import type { ParsedPiSession } from './types';

const PTY_GEOMETRY: TurnPtyGeometry = { cols: 80, rows: 24 };

const BUSY_ERROR = 'A turn is already running in this chat.';
const DISPOSED_ERROR = 'This turn runner has been disposed.';
const READINESS_ERROR = 'Pi did not become ready before the timeout.';
const TURN_TIMEOUT_ERROR = 'The turn timed out before Pi wrote a new assistant reply.';
const NEW_SESSION_TIMEOUT_ERROR = 'No new session file appeared before the timeout.';
export const SESSION_ALREADY_OPEN_ERROR = 'This runner is already attached to a session.';
export const NOT_RUNNING_ERROR = 'There is no running turn to add a message to.';
const EMPTY_MESSAGE_ERROR = 'The message is empty.';
const NOT_A_COMMAND_ERROR = 'This line is not a Pi command.';

/**
 * Alt+Enter — pi's `app.message.followUp` (default on every non-Windows
 * terminal): queue the line until the current run has no tool calls and no
 * steering left. Enter alone is `tui.input.submit`, which pi turns into a
 * *steering* message while a turn is running, so the plain path already means
 * "change direction now": the two intents differ only by this prefix.
 */
const FOLLOW_UP_KEY = '\x1b\r';

/** The pause pi needs between the pasted line and the key that submits it. */
const SUBMIT_DELAY_MS = 250;

/**
 * How long a delivered turn is waited on. This is also how long its chat is
 * reported as running, so it has to outlast a real agent turn — a build plus a
 * test suite routinely takes minutes — instead of cutting the status off mid
 * run. It bounds the poll; it does not cancel anything on the server, and every
 * message queued into the run pushes the deadline out again, so a run the user
 * keeps steering never times out underneath them.
 */
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a tail that looks finished — the assistant-turn count reached, no
 * tool work outstanding — is waited on when the file's last assistant message
 * says pi may still continue (`length`, `error`, or a reason this app does not
 * know). Pi appends an entry the moment it decides to continue (the
 * `context_edit` that omits the attempt it is about to retry), so a file that
 * has not grown for this long is a run that gave up: its answer is already in
 * the file and nothing more is coming. Bounding the wait here keeps a turn
 * that failed for good from reporting "running" for the whole turn deadline —
 * and from leaving its session for the sweep, which has no watch of its own
 * and must not guess.
 */
const NON_FINAL_TAIL_GRACE_MS = 20_000;

/** The pause pi gets between Enter and a dialog being readable on the pane. */
const DIALOG_SETTLE_MS = 1500;

const DISPOSED = Symbol('disposed');
const TURN_DEADLINE = Symbol('turn deadline');

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeUtf8(bytes: Uint8Array): string {
  return createTerminalTextDecoder().decode(bytes);
}

function deliveryError(
  result: Exclude<ComposerDeliveryResult, { status: 'delivered' }>,
): string {
  if (result.status === 'uncertain') return result.error;
  return `The message was not sent (${result.reason}).`;
}

export interface PiTurnRunnerDeps {
  openPty(command: string, geometry: TurnPtyGeometry): Promise<TurnPtyHandle>;
  piCommand: string;
  projectPath: string;
  readSession(path: string): Promise<ParsedPiSession>;
  /**
   * Follow the session file instead of re-reading it: one channel that pushes
   * whatever pi appends, so a running turn costs no round trips at all.
   * Resolves null when this platform cannot stream, and the runner falls back
   * to {@link PiTurnRunnerDeps.readSession} on a timer.
   */
  watchSession?(path: string): Promise<PiSessionWatch | null>;
  newestSessionFile(projectPath: string): Promise<string | null>;
  /**
   * Destroy the conversation's server-side tmux session. Called only once a
   * turn has actually been answered — never on disposal or on a deadline,
   * where Pi may still be working and must be left alone.
   */
  closeSession?(sessionName: string): Promise<void>;
  /**
   * Write down that this chat has a turn in flight in `sessionName`, so a
   * later connection can close the session on its behalf. This runner is the
   * only watcher that kills the session when the reply lands, and it does not
   * always survive the turn: a killed app, a reaped process, or a deadline
   * that expires while the phone is offline leaves Pi finishing in a session
   * nobody watches. Called again, with the raised target, when a queued
   * message joins the run.
   */
  rememberTurn?(turn: { sessionName: string; sessionFile: string; target: number }): void;
  /**
   * The run settled where this runner could see it. Called only once the
   * session is actually gone (or never existed): a forgotten record is a
   * cleanup nobody will do, so a turn that timed out or lost its connection
   * keeps its record for the sweep.
   */
  forgetTurn?(sessionName: string): void;
  /**
   * Read a turn session's screen as plain text (`tmux capture-pane`). Supplied
   * by the store through the live transport; absent in tests that do not
   * exercise dialogs, which disables the feature entirely.
   */
  capturePane?(sessionName: string): Promise<string | null>;
  /** Feed keystrokes to a turn session (`tmux send-keys`). */
  sendKeys?(sessionName: string, keys: readonly string[]): Promise<void>;
  /**
   * A delivered `/command` left a selection dialog waiting on screen. Fired
   * from a background check after delivery, never on the send's own path.
   */
  onDialog?(event: PiScreenDialogEvent): void;
  /**
   * A delivered `/command` printed lines of its own (`Session name set:
   * abcde`). Fired from the same background check, never on the send's path,
   * and only for a command that left no dialog: the dialog card is the output
   * then. Absent without `capturePane`, where nothing can read the screen.
   */
  onCommandOutput?(event: PiCommandOutputEvent): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  submitDelayMs?: number;
  /** How long a dialog is given to draw before the screen is read (tests: 0). */
  dialogSettleMs?: number;
}

export type PiTurnSendResult =
  | { ok: true; session: ParsedPiSession }
  | { ok: false; error: string };

/** What a delivered `/command` printed for itself, off the turn's pane. */
export interface PiCommandOutputEvent {
  /** The conversation the command belongs to; null for a draft. */
  sessionFile: string | null;
  /** The line as typed, so a listener can skip a command it paints itself. */
  command: string;
  /** The new lines, top-down, trimmed and blank-free. */
  lines: string[];
}

export type PiTurnStartNewResult =
  | { ok: true; sessionFile: string; session: ParsedPiSession }
  | { ok: false; error: string };

/**
 * A command is delivered, not awaited: pi handles it in-process and writes no
 * assistant turn, so waiting for one would block for the whole turn timeout
 * over work that already finished. `hiddenUi` means the command opened a
 * surface this chat cannot render, which costs the runner its PTY before the
 * next line (see `piInteractivity`).
 */
export type PiCommandRunResult =
  | { ok: true; hiddenUi: boolean }
  | { ok: false; error: string };

/**
 * A turn whose input has already been delivered: the message is on the
 * server, so the chat may clear its composer and show the turn as running,
 * while `completed` settles when Pi's reply lands in the session file. A
 * failure here means the line never got there, and nothing is pending.
 */
export type PiTurnBegun =
  | {
      ok: true;
      sessionFile: string;
      completed: Promise<PiTurnSendResult>;
      /** How long the delivery's stages took; absent from hand-written stubs. */
      timings?: PiSendTimings;
    }
  | { ok: false; error: string };

/**
 * What a delivery spent its time on, in milliseconds: the four things that sit
 * between the tap and the line leaving for Pi. It is here because the chat
 * cannot paint around them — it paints first and waits — and because the only
 * way to know which of them is worth shortening is to measure them.
 */
export interface PiSendTimings {
  /** Opening the pane (or re-attaching to the one Pi already runs in). */
  openMs: number;
  /** Waiting for Pi's editor to be able to take a line. */
  readyMs: number;
  /** Reading the session file for the turn's baseline — the one big read. */
  baselineMs: number;
  /** Writing the line itself. */
  deliverMs: number;
  /** Adopting the file Pi created for a brand-new conversation. */
  adoptMs: number;
  /** All of the above: the delay the bubble's spinner is covering. */
  totalMs: number;
}

/**
 * Where a message lands when a run is already in flight, in pi's own words:
 *
 * - `steer` — delivered after the current assistant turn's tool calls and
 *   before the next request, so the model can change direction mid-run.
 * - `follow-up` — delivered only once the run has no tool calls and no steering
 *   left, i.e. queued behind the whole task.
 *
 * Neither interrupts anything already running on the server, and neither is a
 * new turn: both join the run that is in flight.
 */
export type TurnQueueKind = 'steer' | 'follow-up';

export type PiTurnQueueResult = { ok: true } | { ok: false; error: string };

/** A turn that is already running on the host, found in a `pendingTurns` record. */
export interface PiTurnAdoption {
  sessionFile: string;
  /** The assistant-turn count the record says means "answered". */
  target: number;
  /** The tmux session Pi is working in; the thing a watcher closes. */
  sessionName: string;
}

export interface PiTurnRunner {
  send(sessionFile: string, message: string): Promise<PiTurnSendResult>;
  startNew(projectPath: string, message: string): Promise<PiTurnStartNewResult>;
  /**
   * Deliver one `/command` and return once pi has accepted the bytes.
   * `sessionFile === null` runs it on the sessionless draft process, so a
   * command picked before the first message does not create a session.
   */
  runCommand(sessionFile: string | null, command: string): Promise<PiCommandRunResult>;
  /**
   * Answer a dialog this runner reported through `onDialog`. `settled` false
   * means the dialog survived the keystroke and is still waiting.
   */
  answerDialog(
    dialog: PiScreenDialog,
    choice: 'confirm' | 'cancel',
    beforePane: string,
  ): Promise<{ ok: boolean; settled: boolean; newLines: string[] }>;
  /**
   * Deliver `message` and resolve as soon as the line is written (plus, for a
   * draft, as soon as Pi's new session file is adopted). The reply is awaited
   * through `completed`, so the caller is never blocked on the agent's runtime.
   */
  beginSend(sessionFile: string, message: string): Promise<PiTurnBegun>;
  beginStartNew(projectPath: string, message: string): Promise<PiTurnBegun>;
  /**
   * Type one more message into the run that is already in flight, as `kind`
   * says. Refused when nothing is running: a new turn goes through
   * `beginSend`, so the caller can never confuse the two.
   */
  queue(sessionFile: string, message: string, kind: TurnQueueKind): Promise<PiTurnQueueResult>;
  /**
   * Take over watching a turn this runner never delivered: the app was killed,
   * or its poll deadline expired while the phone was offline, and the agent
   * kept working in `sessionName` (the case the `pendingTurns` record exists
   * for). Nothing is written and no PTY is opened — the reply is awaited
   * exactly as a delivered turn's is, and the session is torn down when it
   * lands. `queue` re-attaches to that same server-side session, so a turn
   * adopted from a record still accepts steering.
   */
  adopt(turn: PiTurnAdoption): Promise<PiTurnSendResult>;
  /**
   * The transport this runner's PTY was opened on is gone (a reconnect), but
   * the turn is not: drop the dead handle and keep the run's state, so the
   * chat still reports `running` and the next `queue` re-attaches to the
   * server-side session Pi is still working in instead of refusing.
   */
  rebind(): void;
  isBusy(): boolean;
  dispose(): void;
}

interface OpenTurn {
  handle: TurnPtyHandle;
  tracker: ReturnType<typeof createConsoleTracker>;
  delivery: ReturnType<typeof createComposerDeliveryController>;
  ready: boolean;
  /**
   * The last line was a command that took the terminal over, so this PTY must
   * not answer the chat's next line: it is dropped (and pi re-opened on the
   * chat's own session file) before anything else is written.
   */
  restartPending: boolean;
}

/**
 * The run a chat has in flight. `target` is the number of assistant turns the
 * session file must hold before the run counts as settled: the first one is
 * this run's, and every steering/follow-up message adds one, so the chat keeps
 * saying "running" until the last queued instruction has actually been
 * answered. That is what makes a follow-up (answered minutes later) keep the
 * status alive instead of clearing it at the first reply.
 */
interface ActiveRun {
  sessionFile: string;
  target: number;
  deadline: number;
  /**
   * The tmux session this run started in. Read from the open, not recomputed:
   * a draft is named by its project but adopts a real session file as soon as
   * Pi writes one, so the two would disagree.
   */
  sessionName: string | null;
}

export function createPiTurnRunner(deps: PiTurnRunnerDeps): PiTurnRunner {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;

  let busy = false;
  // Set once a delivered turn's reply poll owns the claim; `queue` needs it to
  // know the PTY it should type into is mid-run.
  let run: ActiveRun | null = null;
  let disposed = false;
  let open: OpenTurn | null = null;
  // `null` means the open PTY is the sessionless draft process; a string is
  // the session it was opened with. `startNew` may only reuse a draft.
  let openSessionFile: string | null = null;
  // The tmux session behind the open PTY, as created/attached at open time.
  let openName: string | null = null;
  // The session a reported dialog is pending in. Lives past `dropTurn`: the
  // dialog sits in the server-side tmux session, not in this PTY handle.
  let dialogSession: string | null = null;
  let activeUnsubscribe: (() => void) | null = null;
  let wakeCurrentWait: (() => void) | null = null;
  let nextOperationId = 0;

  function wait(ms: number): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (wakeCurrentWait === finish) wakeCurrentWait = null;
        resolve();
      };
      wakeCurrentWait = finish;
      void sleep(ms).then(finish, finish);
    });
  }

  function unsubscribeActive(): void {
    const unsubscribe = activeUnsubscribe;
    activeUnsubscribe = null;
    unsubscribe?.();
  }

  function subscribe(state: OpenTurn): void {
    if (activeUnsubscribe) return;
    activeUnsubscribe = state.handle.onData((chunk) => {
      state.tracker.push(chunk);
      if (!state.ready && isPiReady(state.tracker.text())) {
        state.ready = true;
      }
    });
  }

  type AwaitOutcome<T> =
    | { kind: 'ok'; value: T }
    | { kind: 'failed'; error: unknown }
    | typeof DISPOSED
    | typeof TURN_DEADLINE;

  /**
   * Await a probe until it settles or the turn deadline/disposal wins. The
   * rejection handler is attached immediately, so an abandoned probe can
   * never surface as an unhandled rejection.
   */
  async function awaitBefore<T>(probe: Promise<T>, deadline: number): Promise<AwaitOutcome<T>> {
    let settled = false;
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    void probe.then(
      (result) => {
        value = result;
        settled = true;
      },
      (error: unknown) => {
        failed = true;
        failure = error;
        settled = true;
      },
    );

    while (!settled) {
      if (disposed) return DISPOSED;
      const remaining = deadline - now();
      if (remaining <= 0) return TURN_DEADLINE;
      await Promise.resolve();
      if (settled) break;
      await wait(Math.min(pollIntervalMs, remaining));
    }

    if (failed) return { kind: 'failed', error: failure };
    return { kind: 'ok', value: value as T };
  }

  async function readAbortable(
    sessionFile: string,
    deadline: number,
  ): Promise<ParsedPiSession | typeof DISPOSED | typeof TURN_DEADLINE> {
    const outcome = await awaitBefore(deps.readSession(sessionFile), deadline);
    if (outcome === DISPOSED || outcome === TURN_DEADLINE) return outcome;
    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.value;
  }

  /**
   * Open the runner's one PTY for this conversation. `sessionFile === null`
   * starts a brand-new session: Pi is opened without `--session` and writes a
   * file of its own on the first message.
   *
   * `name` pins the tmux session for a re-open. A draft cannot recompute its
   * own name — it is random, and the file it adopted afterwards would derive a
   * different one — so re-attaching without it would start a second Pi on the
   * same session file.
   */
  async function ensureOpen(
    sessionFile: string | null,
    projectPath: string,
    name?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (open) return { ok: true };

    let handle: TurnPtyHandle;
    // Resolved once and kept: a draft's name is deliberately not recomputable,
    // so the command and the teardown have to share this one value.
    const sessionName = name ?? turnSessionName(sessionFile, projectPath);
    try {
      const command =
        sessionFile === null
          ? buildPiOpenCommand(deps.piCommand, projectPath, undefined, sessionName)
          : buildPiOpenCommand(deps.piCommand, projectPath, sessionFile, sessionName);
      handle = await deps.openPty(command, { ...PTY_GEOMETRY });
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }

    if (disposed) {
      try {
        handle.close();
      } catch {
        // Disposing already; a failed close must not mask the refusal.
      }
      return { ok: false, error: DISPOSED_ERROR };
    }

    const tracker = createConsoleTracker();
    const delivery = createComposerDeliveryController(
      async (bytes): Promise<PtyWriteAcknowledgement> => {
        try {
          handle.write(decodeUtf8(bytes));
          return { ok: true };
        } catch (error) {
          return { ok: false, message: messageOf(error) };
        }
      },
      sleep,
      { submitDelayMs: deps.submitDelayMs },
    );
    delivery.setTransportState('connected');
    open = { handle, tracker, delivery, ready: false, restartPending: false };
    openSessionFile = sessionFile;
    openName = sessionName;
    return { ok: true };
  }

  /** Close the turn PTY and forget it, so the next delivery opens a fresh one. */
  function dropTurn(): void {
    const state = open;
    open = null;
    openSessionFile = null;
    unsubscribeActive();
    if (!state) return;
    state.delivery.setTransportState('closed');
    try {
      state.handle.close();
    } catch {
      // Best-effort: a PTY that refuses to close is already unusable.
    }
  }

  /**
   * A command that took the terminal over leaves this PTY unable to answer for
   * the chat — its picker would eat the next line, and a session switch would
   * answer into a conversation this chat stopped reading. Dropping it here,
   * right before the next write, lets the command finish first (unlike an Esc,
   * which could abort a `/compact`) and still keeps the next line clean.
   */
  function dropTurnIfSuperseded(): void {
    if (open?.restartPending === true) dropTurn();
  }

  async function waitForReady(
    state: OpenTurn,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (state.ready) return { ok: true };
    const deadline = now() + readyTimeoutMs;
    while (!state.ready) {
      if (disposed) return { ok: false, error: DISPOSED_ERROR };
      // A fresh Pi has to show its bracketed-paste handshake. A session this
      // runner only re-attached to already has a mounted editor: tmux repaints
      // the screen and never re-sends that handshake, so any output at all
      // means the client is on the pane and the editor can take the line.
      const text = state.tracker.text();
      if (text.length > 0 && !text.includes(PI_TURN_CREATED_MARKER)) return { ok: true };
      const remaining = deadline - now();
      if (remaining <= 0) return { ok: false, error: READINESS_ERROR };
      await wait(Math.min(pollIntervalMs, remaining));
    }
    return { ok: true };
  }

  /**
   * The settle decision, shared by the watch and the read loop: the answer is
   * either "the run is over, here is the session" or "keep waiting".
   *
   * The test is the count AND a settled tail AND a final stop reason: pi
   * writes an assistant's text before the tool calls in that same message run,
   * so the count alone is reached seconds into a run that narrates before it
   * works — settling there is what used to kill turns mid-flight.
   *
   * A run pi gave up on shows up differently: the failed call left an
   * assistant message with no text at all, so the assistant-turn count never
   * reaches the target and the whole `answered` test can never hold. The tail
   * saying `error` is the run's own end — without it the chat reports
   * "running" until the ten-minute deadline and the failure never reaches the
   * screen.
   */
  function createSettleTracker(active: ActiveRun): {
    test(session: ParsedPiSession): ParsedPiSession | null;
  } {
    // The watch behind NON_FINAL_TAIL_GRACE_MS: when the file last looked
    // finished, and how many entries it held then.
    let settledSinceMs = now();
    let settledEntryCount: number | undefined;
    return {
      test(session: ParsedPiSession): ParsedPiSession | null {
        if (isRunAnswered(session, active.target)) return session;
        // Only a tail that has stopped for good gets here. The same shape is
        // what a failed turn leaves while pi waits out a retry backoff, so
        // give pi the entry it appends before it continues to appear: a file
        // that has not grown since is a run that is over after all.
        const over =
          session.settled === true &&
          (countAssistantTurns(session) >= active.target || session.stopReason === 'error');
        if (!over || session.entryCount !== settledEntryCount) {
          settledEntryCount = session.entryCount;
          settledSinceMs = now();
        }
        if (over && now() - settledSinceMs >= NON_FINAL_TAIL_GRACE_MS) return session;
        return null;
      },
    };
  }

  /** The follow ended before the run was settled: not a verdict, nor a failure. */
  const WATCH_UNFINISHED = Symbol('watch unfinished');

  async function pollForReplies(active: ActiveRun): Promise<PiTurnSendResult> {
    const settle = createSettleTracker(active);
    if (deps.watchSession) {
      const followed = await pollWithWatch(active, settle);
      // A follow that ended mid-run is not a verdict — the file may well have
      // the answer already — so the read loop finishes the turn.
      if (followed !== WATCH_UNFINISHED) return followed;
    }
    return pollByReading(active, settle);
  }

  /**
   * Follow the file: the host pushes every append, so this loop spends no
   * round trip to learn that something changed.
   */
  async function pollWithWatch(
    active: ActiveRun,
    settle: { test(session: ParsedPiSession): ParsedPiSession | null },
  ): Promise<PiTurnSendResult | typeof WATCH_UNFINISHED> {
    let watch: PiSessionWatch | null = null;
    try {
      watch = await deps.watchSession?.(active.sessionFile) ?? null;
    } catch {
      watch = null;
    }
    if (!watch) return WATCH_UNFINISHED;
    try {
      while (true) {
        if (disposed) return { ok: false, error: DISPOSED_ERROR };
        const answered = settle.test(parsePiSession(watch.text()));
        if (answered) return { ok: true, session: answered };
        // The deadline is re-read every pass: a queued message pushes it out.
        if (now() >= active.deadline) return { ok: false, error: TURN_TIMEOUT_ERROR };
        const changed = await watch.waitForChange(
          Math.min(pollIntervalMs, Math.max(0, active.deadline - now())),
        );
        if (disposed) return { ok: false, error: DISPOSED_ERROR };
        if (watch.closed && !changed) return WATCH_UNFINISHED;
      }
    } finally {
      watch.close();
    }
  }

  /** The fallback: read the whole file on a timer, as before. */
  async function pollByReading(
    active: ActiveRun,
    settle: { test(session: ParsedPiSession): ParsedPiSession | null },
  ): Promise<PiTurnSendResult> {
    while (true) {
      if (disposed) return { ok: false, error: DISPOSED_ERROR };
      try {
        // The deadline is re-read every pass: a queued message pushes it out.
        const session = await readAbortable(active.sessionFile, active.deadline);
        if (session === DISPOSED || disposed) return { ok: false, error: DISPOSED_ERROR };
        if (session === TURN_DEADLINE) return { ok: false, error: TURN_TIMEOUT_ERROR };
        const answered = settle.test(session);
        if (answered) return { ok: true, session: answered };
      } catch {
        // A transient read failure is retried until the deadline.
      }
      await wait(Math.min(pollIntervalMs, Math.max(0, active.deadline - now())));
    }
  }

  /** Deliver one line + CR; returns null on delivery, the typed error otherwise. */
  async function deliverLine(state: OpenTurn, line: string): Promise<string | null> {
    return deliverWith(state, line, 'submit');
  }

  /**
   * Deliver one line and then Alt+Enter instead of Enter. The body goes
   * through the same controller (`intent: 'insert'`, so no CR), and the key is
   * written after the controller's own submit pause — the same gap Enter gets,
   * so pi reads the modifier before the line is submitted.
   */
  async function deliverFollowUp(state: OpenTurn, line: string): Promise<string | null> {
    const failure = await deliverWith(state, line, 'insert');
    if (failure !== null) return failure;
    await sleep(deps.submitDelayMs ?? SUBMIT_DELAY_MS);
    if (disposed) return DISPOSED_ERROR;
    try {
      state.handle.write(FOLLOW_UP_KEY);
    } catch (error) {
      return messageOf(error);
    }
    return null;
  }

  async function deliverWith(
    state: OpenTurn,
    line: string,
    intent: 'insert' | 'submit',
  ): Promise<string | null> {
    const operationId = `pi-turn-${nextOperationId}`;
    nextOperationId += 1;
    let result: ComposerDeliveryResult;
    try {
      result = await state.delivery.deliver({ operationId, payload: line, intent });
    } catch (error) {
      return messageOf(error);
    }
    if (disposed) return DISPOSED_ERROR;
    if (result.status !== 'delivered') return deliveryError(result);
    return null;
  }

  async function pollForNewSessionFile(
    projectPath: string,
    baseline: string | null,
    deadline: number,
  ): Promise<{ ok: true; sessionFile: string } | { ok: false; error: string }> {
    while (true) {
      if (disposed) return { ok: false, error: DISPOSED_ERROR };
      const outcome = await awaitBefore(deps.newestSessionFile(projectPath), deadline);
      if (outcome === DISPOSED || disposed) return { ok: false, error: DISPOSED_ERROR };
      if (outcome === TURN_DEADLINE) {
        return { ok: false, error: NEW_SESSION_TIMEOUT_ERROR };
      }
      if (outcome.kind === 'ok') {
        const newest = outcome.value;
        // A null list or the pre-delivery newest file means Pi has not written
        // the new conversation yet; a transient listing failure is retried.
        if (newest !== null && newest !== baseline) {
          return { ok: true, sessionFile: newest };
        }
      }
      await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }
  }

  /**
   * Own the tail of a delivered turn: poll for every reply the run still owes,
   * then release the runner's data subscription and its busy flag. The claim is
   * handed to this task the moment it is created, so `busy` stays true from the
   * first write until the last reply (or the deadline) — a second *turn* in the
   * same chat is refused in between, while `queue` may still add to this run.
   */
  function startCompletion(active: ActiveRun): Promise<PiTurnSendResult> {
    run = active;
    // The record exists before the reply poll can give up: a deadline that
    // expires while the phone is away is exactly the case the sweep covers.
    if (active.sessionName !== null) {
      deps.rememberTurn?.({
        sessionName: active.sessionName,
        sessionFile: active.sessionFile,
        target: active.target,
      });
    }
    return (async (): Promise<PiTurnSendResult> => {
      let answered = false;
      try {
        const result = await pollForReplies(active);
        answered = result.ok;
        return result;
      } finally {
        unsubscribeActive();
        busy = false;
        if (run === active) run = null;
        // Only a turn that was actually answered may be torn down. A deadline
        // means Pi may still be working (the poll gave up, the agent did not),
        // and a disposal means the connection went away mid-turn — in both
        // cases the server-side session has to outlive this runner.
        if (answered && active.sessionName !== null) {
          const sessionName = active.sessionName;
          // The record goes only once the session is gone: a failed kill keeps
          // it, and the next connection's sweep retries.
          void (async (): Promise<void> => {
            try {
              await deps.closeSession?.(sessionName);
              deps.forgetTurn?.(sessionName);
            } catch {
              // The kill never landed; the record is the retry.
            }
          })();
        }
      }
    })();
  }

  /**
   * Read the assistant-turn baseline this turn has to beat, retrying a
   * transient read failure until the deadline. A baseline that defaults to
   * zero on failure is not safe any more: an existing conversation whose last
   * run settled would satisfy a zero-based target the moment the poll can
   * read again, and the runner would tear the session down right after the
   * line landed — the same mid-run kill the settle test exists to prevent. A
   * disposal or a blown deadline is passed through, so the turn is refused
   * before the line is written rather than delivered without a reply to wait
   * for.
   */
  async function assistantBaseline(
    sessionFile: string,
    deadline: number,
  ): Promise<number | typeof DISPOSED | typeof TURN_DEADLINE> {
    while (true) {
      if (disposed) return DISPOSED;
      try {
        const session = await readAbortable(sessionFile, deadline);
        if (session === DISPOSED || session === TURN_DEADLINE) return session;
        return countAssistantTurns(session);
      } catch {
        const remaining = deadline - now();
        if (remaining <= 0) return TURN_DEADLINE;
        await wait(Math.min(pollIntervalMs, remaining));
      }
    }
  }

  /** Zeroed stage timings, filled in as the delivery moves through them. */
  function emptyTimings(): PiSendTimings {
    return { openMs: 0, readyMs: 0, baselineMs: 0, deliverMs: 0, adoptMs: 0, totalMs: 0 };
  }

  /**
   * Time one stage of a delivery. The number is all this adds: the stages are
   * the delivery itself, and none of them moves to make it measurable.
   */
  async function measure<T>(
    timings: PiSendTimings,
    stage: 'openMs' | 'readyMs' | 'baselineMs' | 'deliverMs' | 'adoptMs',
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    try {
      return await run();
    } finally {
      timings[stage] = now() - startedAt;
    }
  }

  /**
   * One line per delivery, saying which stage the spinner was covering. Same
   * shape as the launch-reconnect log: a tag that greps, numbers only — never
   * the message, the file or what came back.
   */
  function logSendTimings(kind: 'send' | 'start-new', timings: PiSendTimings): void {
    console.debug(
      `[pi turn] ${kind} open=${timings.openMs} ready=${timings.readyMs}`
      + ` baseline=${timings.baselineMs} deliver=${timings.deliverMs}`
      + ` adopt=${timings.adoptMs} total=${timings.totalMs}`,
    );
  }

  async function beginSend(sessionFile: string, message: string): Promise<PiTurnBegun> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };
    busy = true;
    // Set once the reply poll owns the claim; until then this function still
    // has to clean up after itself.
    let handedOff = false;
    const timings = emptyTimings();
    const startedAt = now();
    try {
      const deadline = now() + turnTimeoutMs;
      dropTurnIfSuperseded();
      const opened = await measure(timings, 'openMs', () => ensureOpen(sessionFile, deps.projectPath));
      if (!opened.ok) return opened;
      const state = open;
      if (!state) return { ok: false, error: DISPOSED_ERROR };

      subscribe(state);
      const ready = await measure(timings, 'readyMs', () => waitForReady(state));
      if (!ready.ok) return ready;
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      const baseline = await measure(timings, 'baselineMs', () => assistantBaseline(sessionFile, deadline));
      if (baseline === DISPOSED || disposed) return { ok: false, error: DISPOSED_ERROR };
      if (baseline === TURN_DEADLINE) return { ok: false, error: TURN_TIMEOUT_ERROR };

      const deliveryFailure = await measure(timings, 'deliverMs', () => deliverLine(state, line));
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };

      const completed = startCompletion({
        sessionFile,
        target: baseline + 1,
        deadline,
        sessionName: openName,
      });
      handedOff = true;
      timings.totalMs = now() - startedAt;
      logSendTimings('send', timings);
      return { ok: true, sessionFile, completed, timings };
    } finally {
      if (!handedOff) {
        unsubscribeActive();
        busy = false;
      }
    }
  }

  async function beginStartNew(projectPath: string, message: string): Promise<PiTurnBegun> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    if (open !== null && openSessionFile !== null) {
      return { ok: false, error: SESSION_ALREADY_OPEN_ERROR };
    }
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };
    busy = true;
    let handedOff = false;
    const timings = emptyTimings();
    const startedAt = now();
    try {
      const deadline = now() + turnTimeoutMs;
      // A new conversation is opened without `--session`, in the project dir.
      dropTurnIfSuperseded();
      const opened = await measure(timings, 'openMs', () => ensureOpen(null, projectPath));
      if (!opened.ok) return opened;
      const state = open;
      if (!state) return { ok: false, error: DISPOSED_ERROR };

      subscribe(state);
      const ready = await measure(timings, 'readyMs', () => waitForReady(state));
      if (!ready.ok) return ready;
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      // Capture the newest file before delivering, so only a file Pi writes
      // for this message is adopted.
      const baselineOutcome = await measure(timings, 'baselineMs', () => awaitBefore(
        deps.newestSessionFile(projectPath),
        deadline,
      ));
      if (baselineOutcome === DISPOSED || disposed) {
        return { ok: false, error: DISPOSED_ERROR };
      }
      if (baselineOutcome === TURN_DEADLINE) {
        return { ok: false, error: TURN_TIMEOUT_ERROR };
      }
      if (baselineOutcome.kind === 'failed') {
        return { ok: false, error: messageOf(baselineOutcome.error) };
      }

      const deliveryFailure = await measure(timings, 'deliverMs', () => deliverLine(state, line));
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };

      const adopted = await measure(timings, 'adoptMs', () => pollForNewSessionFile(
        projectPath,
        baselineOutcome.value,
        deadline,
      ));
      if (!adopted.ok) return adopted;

      // The new file exists; its first assistant turn is awaited on the same
      // deadline (a brand-new session has no assistant turns to beat).
      const completed = startCompletion({
        sessionFile: adopted.sessionFile,
        target: 1,
        deadline,
        sessionName: openName,
      });
      handedOff = true;
      timings.totalMs = now() - startedAt;
      logSendTimings('start-new', timings);
      return { ok: true, sessionFile: adopted.sessionFile, completed, timings };
    } finally {
      if (!handedOff) {
        unsubscribeActive();
        busy = false;
      }
    }
  }

  /**
   * Deliver one `/command`. Unlike a message there is no turn to wait for: pi
   * handles the command itself and appends nothing to the session file, so the
   * assistant poll would report its 120 s timeout over work that already ran.
   * The contract is "pi accepted the bytes" — the ack from the PTY write — and
   * nothing more.
   *
   * One thing does follow the delivery, off the send's own path: an extension
   * command may leave a selection dialog waiting on the pane (`/nix` asks
   * before deleting a session). The screen is read once after a settle delay
   * and, when a dialog is found, reported through `onDialog` — the chat shows
   * it with native buttons, because the next line the runner delivers would
   * otherwise answer the dialog's highlighted option (for `confirm`, Yes).
   */
  async function runCommand(
    sessionFile: string | null,
    command: string,
  ): Promise<PiCommandRunResult> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    const slash = parseSlashLine(command);
    if (slash === null) return { ok: false, error: NOT_A_COMMAND_ERROR };
    busy = true;
    try {
      dropTurnIfSuperseded();
      const opened = await ensureOpen(sessionFile, deps.projectPath);
      if (!opened.ok) return opened;
      const state = open;
      if (!state) return { ok: false, error: DISPOSED_ERROR };

      subscribe(state);
      const ready = await waitForReady(state);
      if (!ready.ok) return ready;
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      // A command that takes the terminal over is read no further: its
      // surface is not something this chat can show.
      const takeover = takesOverTerminal(slash);
      // The screen as it is before the command, so what the command prints can
      // be told apart from what was already there. A capture that fails costs
      // only the confirmation line: the command itself still runs.
      const before = takeover ? null : await captureBefore();

      const deliveryFailure = await deliverLine(state, slash.line);
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };

      const hiddenUi = !disposed && takeover;
      if (hiddenUi) state.restartPending = true;
      if (!hiddenUi) void readScreenAfterCommand(sessionFile, slash.line, before);
      return { ok: true, hiddenUi };
    } finally {
      unsubscribeActive();
      busy = false;
    }
  }

  /** The turn pane's text, or null when it cannot be read right now. */
  async function captureBefore(): Promise<string | null> {
    const capture = deps.capturePane;
    if (capture === undefined || openName === null) return null;
    return capture(openName).catch(() => null);
  }

  /**
   * Read the pane once after the settle delay: report a waiting selection
   * dialog, or hand the chat the lines the command printed for itself
   * (`Session name set: abcde`). Every failure is silence: a screen this
   * cannot read changes nothing about the delivery that already succeeded.
   */
  async function readScreenAfterCommand(
    sessionFile: string | null,
    command: string,
    before: string | null,
  ): Promise<void> {
    const capture = deps.capturePane;
    if (disposed || capture === undefined || openName === null) return;
    const sessionName = openName;
    await sleep(deps.dialogSettleMs ?? DIALOG_SETTLE_MS);
    if (disposed) return;
    const pane = await capture(sessionName).catch(() => null);
    if (pane === null || openName !== sessionName) return;
    const dialog = parseScreenDialog(pane);
    if (dialog !== null) {
      dialogSession = sessionName;
      deps.onDialog?.({ dialog, pane, sessionName });
      return;
    }
    if (before === null) return;
    const lines = commandOutputLines(before, pane, command);
    if (lines.length > 0) deps.onCommandOutput?.({ sessionFile, command, lines });
  }

  /**
   * Answer the dialog this runner reported: send the keystrokes, wait for pi
   * to settle, and diff the screen so the chat can show the line the command's
   * handler printed (` /nix cancelled.`). `settled` false means the dialog is
   * still on screen — the answer keystroke did not land, so the caller keeps
   * the dialog up rather than reporting a result pi never saw.
   */
  async function answerDialog(
    dialog: PiScreenDialog,
    choice: 'confirm' | 'cancel',
    beforePane: string,
  ): Promise<{ ok: boolean; settled: boolean; newLines: string[] }> {
    const send = deps.sendKeys;
    const capture = deps.capturePane;
    // The detection set the target; a re-attached runner falls back to its
    // open PTY's session — same conversation, same pane.
    const target = dialogSession ?? openName;
    if (disposed || send === undefined || capture === undefined || target === null) {
      return { ok: false, settled: true, newLines: [] };
    }
    try {
      await send(target, dialogAnswerKeys(dialog, choice));
    } catch (error) {
      return { ok: false, settled: true, newLines: [messageOf(error)] };
    }
    await sleep(deps.dialogSettleMs ?? DIALOG_SETTLE_MS);
    const after = await capture(target).catch(() => null);
    if (after === null) return { ok: true, settled: false, newLines: [] };
    const settled = parseScreenDialog(after) === null;
    if (settled) dialogSession = null;
    return { ok: true, settled, newLines: newPaneLines(beforePane, after) };
  }

  /**
   * Add one message to the run in flight. Nothing is opened and no new claim is
   * taken: pi's own queue owns the ordering from here (steering drains before
   * follow-ups, both before a new turn), and this runner only has to keep the
   * run's arithmetic honest — one more reply is owed, so the chat keeps saying
   * "running" until it lands.
   */
  async function queue(
    sessionFile: string,
    message: string,
    kind: TurnQueueKind,
  ): Promise<PiTurnQueueResult> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    const active = run;
    // The run — not the PTY — is what makes a chat joinable. A reconnect drops
    // the handle and keeps the run, so the line below re-attaches to the tmux
    // session Pi is still working in instead of refusing.
    if (active === null || active.sessionFile !== sessionFile) {
      return { ok: false, error: NOT_RUNNING_ERROR };
    }
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };

    let state = open;
    if (state === null) {
      // The run's own name, not one derived from its file: a draft is named
      // randomly and re-deriving would open a second Pi on the same file.
      const reopened = await ensureOpen(
        sessionFile,
        deps.projectPath,
        active.sessionName ?? undefined,
      );
      if (!reopened.ok) return reopened;
      state = open;
      if (state === null) return { ok: false, error: DISPOSED_ERROR };
      subscribe(state);
      const ready = await waitForReady(state);
      if (!ready.ok) return ready;
      state = open;
      if (state === null) return { ok: false, error: DISPOSED_ERROR };
    }
    // A draft is opened sessionless and only learns its file afterwards, so
    // the open may legitimately have no session file; anything else has to be
    // the same conversation the run belongs to.
    if (openSessionFile !== null && openSessionFile !== sessionFile) {
      return { ok: false, error: NOT_RUNNING_ERROR };
    }

    // Count the reply *before* the write: the current turn's reply can land
    // between the two awaits, and a target that arrives late would let the poll
    // settle on a reply this message never got.
    active.target += 1;
    active.deadline = now() + turnTimeoutMs;
    // The record is raised before the write, for the same reason and in the
    // safer direction: a sweep that believed the lower target could close this
    // session on the first of the two answers. A failed write is rolled back
    // below, so a lost message cannot leave the record waiting for a reply
    // that was never asked for.
    if (active.sessionName !== null) {
      deps.rememberTurn?.({
        sessionName: active.sessionName,
        sessionFile: active.sessionFile,
        target: active.target,
      });
    }
    const failure =
      kind === 'steer'
        ? await deliverLine(state, line)
        : await deliverFollowUp(state, line);
    if (failure !== null) {
      active.target -= 1;
      if (active.sessionName !== null) {
        deps.rememberTurn?.({
          sessionName: active.sessionName,
          sessionFile: active.sessionFile,
          target: active.target,
        });
      }
      return { ok: false, error: failure };
    }
    return { ok: true };
  }

  /** One-shot turn: deliver, then await the reply (the pre-two-phase contract). */
  async function send(sessionFile: string, message: string): Promise<PiTurnSendResult> {
    const begun = await beginSend(sessionFile, message);
    if (!begun.ok) return begun;
    return begun.completed;
  }

  /**
   * Watch a turn that is already running on the host. This is the recovery
   * path for a watcher that died with the app: the record it left behind names
   * the file, the count that means answered, and the tmux session, which is
   * everything the poll and the teardown need — no delivery, no PTY, no
   * readiness wait.
   *
   * The session name is kept as this runner's open pane even though nothing is
   * attached to it: `queue` and `answerDialog` address the agent by name, so an
   * adopted run behaves like any other from here on.
   */
  function adopt(turn: PiTurnAdoption): Promise<PiTurnSendResult> {
    if (disposed) return Promise.resolve({ ok: false, error: DISPOSED_ERROR });
    if (busy) return Promise.resolve({ ok: false, error: BUSY_ERROR });
    busy = true;
    openName = turn.sessionName;
    return startCompletion({
      sessionFile: turn.sessionFile,
      target: turn.target,
      deadline: now() + turnTimeoutMs,
      sessionName: turn.sessionName,
    });
  }

  async function startNew(
    projectPath: string,
    message: string,
  ): Promise<PiTurnStartNewResult> {
    const begun = await beginStartNew(projectPath, message);
    if (!begun.ok) return begun;
    const completed = await begun.completed;
    if (!completed.ok) return completed;
    return { ok: true, sessionFile: begun.sessionFile, session: completed.session };
  }

  function isBusy(): boolean {
    return busy;
  }

  /**
   * The channel this runner was watching its turn through is dead (the phone
   * reconnected); the turn itself is not. Drop the handle, keep the run: the
   * chat keeps saying "running", `queue` re-attaches on demand, and the reply
   * poll keeps reading the session file through the new transport (its reads
   * go through the live seam, not through this handle).
   */
  function rebind(): void {
    if (disposed) return;
    const state = open;
    open = null;
    openSessionFile = null;
    unsubscribeActive();
    if (state) {
      state.delivery.setTransportState('closed');
      try {
        state.handle.close();
      } catch {
        // The transport is already gone; the close is best-effort.
      }
    }
    // `run`, `busy` and `openName` survive on purpose: they describe the turn
    // on the server, not the channel that was watching it.
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const state = open;
    open = null;
    openSessionFile = null;
    openName = null;
    dialogSession = null;
    run = null;
    unsubscribeActive();
    if (state) {
      state.delivery.setTransportState('closed');
      try {
        state.handle.close();
      } catch {
        // Close is best-effort; the runner is already unusable.
      }
    }
    wakeCurrentWait?.();
  }

  return { send, startNew, runCommand, answerDialog, beginSend, beginStartNew, queue, adopt, rebind, isBusy, dispose };
}
