import type { ComposerDeliveryResult } from '@pocketshell/core';
import { createTerminalTextDecoder } from '../phone/terminalText';
import {
  createComposerDeliveryController,
  type PtyWriteAcknowledgement,
} from '../session/composerDelivery';
import type { TurnPtyGeometry, TurnPtyHandle } from '../session/turnPty';
import { parseSlashLine, takesOverTerminal } from './piInteractivity';
import { buildPiOpenCommand, toTurnLine } from './piTurn';
import { createConsoleTracker, isPiReady } from './turnReadiness';
import type { ParsedPiSession } from './types';

const PTY_GEOMETRY: TurnPtyGeometry = { cols: 80, rows: 24 };

const BUSY_ERROR = 'A turn is already running in this chat.';
const DISPOSED_ERROR = 'This turn runner has been disposed.';
const READINESS_ERROR = 'Pi did not become ready before the timeout.';
const TURN_TIMEOUT_ERROR = 'The turn timed out before Pi wrote a new assistant reply.';
const NEW_SESSION_TIMEOUT_ERROR = 'No new session file appeared before the timeout.';
export const SESSION_ALREADY_OPEN_ERROR = 'This runner is already attached to a session.';
const EMPTY_MESSAGE_ERROR = 'The message is empty.';
const NOT_A_COMMAND_ERROR = 'This line is not a Pi command.';

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

function assistantTurnCount(session: ParsedPiSession): number {
  return session.turns.filter((turn) => turn.role === 'assistant').length;
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
  newestSessionFile(projectPath: string): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  submitDelayMs?: number;
}

export type PiTurnSendResult =
  | { ok: true; session: ParsedPiSession }
  | { ok: false; error: string };

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

export interface PiTurnRunner {
  send(sessionFile: string, message: string): Promise<PiTurnSendResult>;
  startNew(projectPath: string, message: string): Promise<PiTurnStartNewResult>;
  /**
   * Deliver one `/command` and return once pi has accepted the bytes.
   * `sessionFile === null` runs it on the sessionless draft process, so a
   * command picked before the first message does not create a session.
   */
  runCommand(sessionFile: string | null, command: string): Promise<PiCommandRunResult>;
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

export function createPiTurnRunner(deps: PiTurnRunnerDeps): PiTurnRunner {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
  const turnTimeoutMs = deps.turnTimeoutMs ?? 120_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;

  let busy = false;
  let disposed = false;
  let open: OpenTurn | null = null;
  // `null` means the open PTY is the sessionless draft process; a string is
  // the session it was opened with. `startNew` may only reuse a draft.
  let openSessionFile: string | null = null;
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
   */
  async function ensureOpen(
    sessionFile: string | null,
    projectPath: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (open) return { ok: true };

    let handle: TurnPtyHandle;
    try {
      const command =
        sessionFile === null
          ? buildPiOpenCommand(deps.piCommand, projectPath)
          : buildPiOpenCommand(deps.piCommand, projectPath, sessionFile);
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
      const remaining = deadline - now();
      if (remaining <= 0) return { ok: false, error: READINESS_ERROR };
      await wait(Math.min(pollIntervalMs, remaining));
    }
    return { ok: true };
  }

  async function pollForAssistant(
    sessionFile: string,
    baseline: number,
    deadline: number,
  ): Promise<PiTurnSendResult> {
    while (true) {
      if (disposed) return { ok: false, error: DISPOSED_ERROR };
      try {
        const session = await readAbortable(sessionFile, deadline);
        if (session === DISPOSED || disposed) return { ok: false, error: DISPOSED_ERROR };
        if (session === TURN_DEADLINE) return { ok: false, error: TURN_TIMEOUT_ERROR };
        if (assistantTurnCount(session) > baseline) return { ok: true, session };
      } catch {
        // A transient read failure is retried until the deadline.
      }
      await wait(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    }
  }

  /** Deliver one line + CR; returns null on delivery, the typed error otherwise. */
  async function deliverLine(state: OpenTurn, line: string): Promise<string | null> {
    const operationId = `pi-turn-${nextOperationId}`;
    nextOperationId += 1;
    let result: ComposerDeliveryResult;
    try {
      result = await state.delivery.deliver({
        operationId,
        payload: line,
        intent: 'submit',
      });
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

  async function send(sessionFile: string, message: string): Promise<PiTurnSendResult> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };
    busy = true;
    try {
      const deadline = now() + turnTimeoutMs;
      dropTurnIfSuperseded();
      const opened = await ensureOpen(sessionFile, deps.projectPath);
      if (!opened.ok) return opened;
      const state = open;
      if (!state) return { ok: false, error: DISPOSED_ERROR };

      subscribe(state);
      const ready = await waitForReady(state);
      if (!ready.ok) return ready;
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      let baseline = 0;
      try {
        const session = await readAbortable(sessionFile, deadline);
        if (session === DISPOSED || disposed) return { ok: false, error: DISPOSED_ERROR };
        if (session === TURN_DEADLINE) return { ok: false, error: TURN_TIMEOUT_ERROR };
        baseline = assistantTurnCount(session);
      } catch {
        // A brand-new conversation may not exist yet.
      }
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      const deliveryFailure = await deliverLine(state, line);
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };
      return await pollForAssistant(sessionFile, baseline, deadline);
    } finally {
      unsubscribeActive();
      busy = false;
    }
  }

  async function startNew(
    projectPath: string,
    message: string,
  ): Promise<PiTurnStartNewResult> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    if (open !== null && openSessionFile !== null) {
      return { ok: false, error: SESSION_ALREADY_OPEN_ERROR };
    }
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };
    busy = true;
    try {
      const deadline = now() + turnTimeoutMs;
      // A new conversation is opened without `--session`, in the project dir.
      dropTurnIfSuperseded();
      const opened = await ensureOpen(null, projectPath);
      if (!opened.ok) return opened;
      const state = open;
      if (!state) return { ok: false, error: DISPOSED_ERROR };

      subscribe(state);
      const ready = await waitForReady(state);
      if (!ready.ok) return ready;
      if (disposed) return { ok: false, error: DISPOSED_ERROR };

      // Capture the newest file before delivering, so only a file Pi writes
      // for this message is adopted.
      const baselineOutcome = await awaitBefore(
        deps.newestSessionFile(projectPath),
        deadline,
      );
      if (baselineOutcome === DISPOSED || disposed) {
        return { ok: false, error: DISPOSED_ERROR };
      }
      if (baselineOutcome === TURN_DEADLINE) {
        return { ok: false, error: TURN_TIMEOUT_ERROR };
      }
      if (baselineOutcome.kind === 'failed') {
        return { ok: false, error: messageOf(baselineOutcome.error) };
      }

      const deliveryFailure = await deliverLine(state, line);
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };

      const adopted = await pollForNewSessionFile(
        projectPath,
        baselineOutcome.value,
        deadline,
      );
      if (!adopted.ok) return adopted;

      // The new file exists; wait for its first assistant turn on the same
      // deadline (a brand-new session has no assistant turns to beat).
      const completed = await pollForAssistant(adopted.sessionFile, 0, deadline);
      if (!completed.ok) return completed;
      return {
        ok: true,
        sessionFile: adopted.sessionFile,
        session: completed.session,
      };
    } finally {
      unsubscribeActive();
      busy = false;
    }
  }

  /**
   * Deliver one `/command`. Unlike a message there is no turn to wait for: pi
   * handles the command itself and appends nothing to the session file, so the
   * assistant poll would report its 120 s timeout over work that already ran.
   * The contract is "pi accepted the bytes" — the ack from the PTY write — and
   * nothing more.
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

      const deliveryFailure = await deliverLine(state, slash.line);
      if (deliveryFailure !== null) return { ok: false, error: deliveryFailure };

      const hiddenUi = !disposed && takesOverTerminal(slash);
      if (hiddenUi) state.restartPending = true;
      return { ok: true, hiddenUi };
    } finally {
      unsubscribeActive();
      busy = false;
    }
  }

  function isBusy(): boolean {
    return busy;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    dropTurn();
    wakeCurrentWait?.();
  }

  return { send, startNew, runCommand, isBusy, dispose };
}
