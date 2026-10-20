import type { ComposerDeliveryResult } from '@pocketshell/core';
import { createTerminalTextDecoder } from '../phone/terminalText';
import {
  createComposerDeliveryController,
  type PtyWriteAcknowledgement,
} from '../session/composerDelivery';
import type { TurnPtyGeometry, TurnPtyHandle } from '../session/turnPty';
import { buildPiOpenCommand, toTurnLine } from './piTurn';
import { createConsoleTracker, isPiReady } from './turnReadiness';
import type { ParsedPiSession } from './types';

const PTY_GEOMETRY: TurnPtyGeometry = { cols: 80, rows: 24 };

const BUSY_ERROR = 'A turn is already running in this chat.';
const DISPOSED_ERROR = 'This turn runner has been disposed.';
const READINESS_ERROR = 'Pi did not become ready before the timeout.';
const TURN_TIMEOUT_ERROR = 'The turn timed out before Pi wrote a new assistant reply.';
const EMPTY_MESSAGE_ERROR = 'The message is empty.';

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

export interface PiTurnRunner {
  send(sessionFile: string, message: string): Promise<PiTurnSendResult>;
  isBusy(): boolean;
  dispose(): void;
}

interface OpenTurn {
  handle: TurnPtyHandle;
  tracker: ReturnType<typeof createConsoleTracker>;
  delivery: ReturnType<typeof createComposerDeliveryController>;
  ready: boolean;
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

  async function readAbortable(
    sessionFile: string,
    deadline: number,
  ): Promise<ParsedPiSession | typeof DISPOSED | typeof TURN_DEADLINE> {
    let settled = false;
    let session: ParsedPiSession | undefined;
    let readFailed = false;
    let failure: unknown;
    const read = deps.readSession(sessionFile).then(
      (result) => {
        session = result;
        settled = true;
      },
      (error: unknown) => {
        readFailed = true;
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

    await read;
    if (readFailed) throw failure;
    return session as ParsedPiSession;
  }

  async function ensureOpen(
    sessionFile: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (open) return { ok: true };

    let handle: TurnPtyHandle;
    try {
      const command = buildPiOpenCommand(deps.piCommand, deps.projectPath, sessionFile);
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
    open = { handle, tracker, delivery, ready: false };
    return { ok: true };
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

  async function send(sessionFile: string, message: string): Promise<PiTurnSendResult> {
    if (disposed) return { ok: false, error: DISPOSED_ERROR };
    if (busy) return { ok: false, error: BUSY_ERROR };
    const line = toTurnLine(message);
    if (line === '') return { ok: false, error: EMPTY_MESSAGE_ERROR };
    busy = true;
    try {
      const deadline = now() + turnTimeoutMs;
      const opened = await ensureOpen(sessionFile);
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
        return { ok: false, error: messageOf(error) };
      }
      if (disposed) return { ok: false, error: DISPOSED_ERROR };
      if (result.status !== 'delivered') {
        return { ok: false, error: deliveryError(result) };
      }
      return await pollForAssistant(sessionFile, baseline, deadline);
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
    const state = open;
    open = null;
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

  return { send, isBusy, dispose };
}
