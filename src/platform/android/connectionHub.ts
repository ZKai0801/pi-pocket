/**
 * The Android connection registry behind the shared app's `ssh` group.
 *
 * Every logical connection the shared app sees is one core
 * {@link ConnectionController}. The controller is the single owner of dial,
 * host-key verdicts, reconnect and background grace (D28); this hub only
 * translates between the shared app's transport vocabulary (connection ids,
 * `ConnectionState`) and the controller's snapshot. It makes no reconnect
 * decision of its own:
 *
 *  - the connection id the shared app holds is LOGICAL and stable across the
 *    controller's internal re-dials, so the shared connection store never
 *    sees a new id and never re-keys its surfaces;
 *  - `reconnecting` (with the ladder's attempt and budget) is reported while
 *    the controller walks its ladder — including between a refused dial and
 *    the next one — and `lost` (with the controller's reason) only once it
 *    has given up;
 *  - the hub advertises `ssh.reconnect` (see `androidApi.ts`), so the shared
 *    store runs no ladder of its own and its Retry asks the controller for
 *    one recovery of the same logical id (#2954, D28: one reconnect owner).
 *
 * The chat-only cut (D45) removed the hub's session-attach machinery: the
 * phone app opens no session PTYs through the shared app's `shell` group
 * (the chat's turn PTY rides the native `sshCapability.openPty` directly),
 * so the attach bookkeeping and the session listing are gone from this repo.
 */
import type { ConnectionStateEvent } from '@ui/app/api';
import {
  readSshCapabilityError,
  type ConnectResult,
  type ConnectionController,
  type ConnectionSnapshot,
  type ConnectionState,
  type ExecResult,
  type HostKeyTrustChoice,
  type HostKeyTrustRequest,
  type PendingHostKeyDecision,
  type SshHostTarget,
} from '@pocketshell/core';

/** Default timeout for a generic `ssh.exec` from the shared app. */
export const HOST_COMMAND_TIMEOUT_MS = 30_000;

export type ConnectionStateListener = (payload: ConnectionStateEvent) => void;

export type TofuDecision = HostKeyTrustChoice;

/**
 * Asks the user about a first-contact host key (the shared app's
 * `ssh.onTrustDecision` decider). Resolves with the user's answer.
 */
export type TrustDecider = (request: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>;

interface ConnectionRecord {
  id: string;
  controller: ConnectionController;
  lastState: ConnectionState | null;
  lastAttempt: number;
  unsubscribe: Array<() => void>;
}

/**
 * One controller snapshot as the hub saw it, keyed by the LOGICAL id — the
 * diagnostics stream a packaged journey reads to count ladders and dials
 * without trusting the UI (#2954).
 */
export interface ConnectionJournalEntry {
  at: number;
  /** The logical id the shared app holds. */
  connectionId: string;
  phase: ConnectionSnapshot['phase'];
  retryAttempt: number;
  /** The native transport id of the current generation (null between dials). */
  transportId: string | null;
  generationId: string | null;
  selectedId: string | null;
  selectedName: string | null;
  selectedTag: string | null;
  error: string | null;
}

export interface ConnectionHubOptions {
  /** A fresh controller per logical connection (bound to the native capability). */
  createController: () => ConnectionController;
  /** Every controller snapshot, for diagnostics; never drives behaviour. */
  observe?: (entry: ConnectionJournalEntry) => void;
}

/** Map the controller's phase to the shared app's four-word connection state. */
export function connectionStateFor(snapshot: ConnectionSnapshot): ConnectionState {
  switch (snapshot.phase) {
    case 'idle':
      return 'idle';
    case 'connecting':
      // A dial inside the controller's retry ladder is still the recovery.
      return snapshot.retryAttempt > 0 ? 'reconnecting' : 'connecting';
    case 'awaiting-trust':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'lost':
      return 'lost';
    case 'error':
      // An operation failed on a live transport: the link is still up. A
      // failed dial leaves no transport behind — inside the retry ladder that
      // is one refused attempt, not the give-up (the controller says `lost`
      // itself when the budget is spent).
      if (snapshot.connectionId) return 'connected';
      return snapshot.retryAttempt > 0 ? 'reconnecting' : 'lost';
    default:
      return 'connected';
  }
}

export class AndroidConnectionHub {
  private readonly records = new Map<string, ConnectionRecord>();
  private readonly stateListeners = new Set<ConnectionStateListener>();
  private nextConnection = 1;
  private trustDecider: TrustDecider | null = null;

  constructor(private readonly options: ConnectionHubOptions) {}

  // --- ssh ------------------------------------------------------------------

  /**
   * Register the shared app's host-key decider (`ssh.onTrustDecision`). One
   * decider at a time; the returned closure unregisters it.
   */
  setTrustDecider(decider: TrustDecider): () => void {
    this.trustDecider = decider;
    return () => {
      if (this.trustDecider === decider) this.trustDecider = null;
    };
  }

  /**
   * Dial `target` on a fresh controller.
   *
   * Host keys, in the controller's terms:
   *  - pinned and matching: connects;
   *  - first contact (`trust-required`): an explicit `tofuDecision` answers it;
   *    without one the registered decider asks the user, and with no decider
   *    the key is refused (fail closed — never a silent pin). `accept-always`
   *    records the pin, `accept-once` trusts it for this controller only;
   *  - CHANGED (`trust-mismatch`): refused outright with a visible message. It
   *    never reaches the prompt and no decision can override it here.
   */
  async connect(
    target: SshHostTarget,
    tofuDecision?: TofuDecision,
    hostLabel: string = target.hostname,
  ): Promise<ConnectResult> {
    const controller = this.options.createController();
    let result = await controller.connect(target);
    if (!result.ok && result.reason === 'trust-required') {
      const pending = controller.getSnapshot().trustDecision;
      const decision = tofuDecision ?? (pending ? await this.askTrust(target, hostLabel, pending) : 'reject');
      if (decision === 'reject') {
        await controller.close().catch(() => undefined);
        return {
          ok: false,
          error: `Host key for ${hostLabel} was not trusted. No connection was opened.`,
        };
      }
      result = await controller.acceptPresentedHostKey({ persist: decision === 'accept-always' });
    } else if (!result.ok && result.reason === 'trust-mismatch') {
      const pending = controller.getSnapshot().trustDecision;
      await controller.close().catch(() => undefined);
      return { ok: false, error: hostKeyChangedMessage(hostLabel, pending) };
    }
    if (!result.ok) {
      await controller.close().catch(() => undefined);
      return { ok: false, error: result.message };
    }
    const id = `android-${this.nextConnection++}`;
    const record: ConnectionRecord = {
      id,
      controller,
      lastState: null,
      lastAttempt: 0,
      unsubscribe: [],
    };
    this.records.set(id, record);
    record.unsubscribe.push(controller.subscribe((snapshot) => this.onSnapshot(record, snapshot)));
    return { ok: true, connectionId: id };
  }

  async close(connectionId: string): Promise<boolean> {
    const record = this.records.get(connectionId);
    if (!record) return false;
    this.records.delete(connectionId);
    for (const unsubscribe of record.unsubscribe) unsubscribe();
    await record.controller.close().catch(() => undefined);
    this.emitState(connectionId, 'idle');
    return true;
  }

  async exec(connectionId: string, command: string, timeoutMs = HOST_COMMAND_TIMEOUT_MS): Promise<ExecResult> {
    const result = await this.recordOf(connectionId).controller.runHostCommand(command, timeoutMs);
    if (!result.ok) throw new Error(result.message);
    return {
      exitCode: result.value.exitCode ?? -1,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
    };
  }

  /**
   * The shared store's Retry: one controller recovery of this logical
   * connection (joining a ladder already running). True once the transport
   * is back.
   */
  async reconnect(connectionId: string): Promise<boolean> {
    const result = await this.recordOf(connectionId).controller.reconnect();
    return result.ok;
  }

  onState(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  // --- lifecycle --------------------------------------------------------------

  /** Android paused the activity: every live controller starts its grace. */
  async enterBackground(graceMs: number): Promise<void> {
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        const phase = record.controller.getSnapshot().phase;
        if (phase === 'live' || phase === 'connected') {
          await record.controller.enterBackground(graceMs).catch(() => undefined);
        }
      }),
    );
  }

  /** Android resumed: each controller reuses or re-dials within its own policy. */
  async returnToForeground(): Promise<void> {
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        if (record.controller.getSnapshot().phase === 'background') {
          await record.controller.returnToForeground().catch(() => undefined);
        }
      }),
    );
  }

  /** Test and diagnostics view of the registry. */
  controllerOf(connectionId: string): ConnectionController | null {
    return this.records.get(connectionId)?.controller ?? null;
  }

  // --- internals --------------------------------------------------------------

  private async askTrust(
    target: SshHostTarget,
    hostLabel: string,
    pending: PendingHostKeyDecision,
  ): Promise<HostKeyTrustChoice> {
    const decider = this.trustDecider;
    if (!decider) return 'reject';
    try {
      return await decider({
        hostLabel,
        hostname: target.hostname,
        port: target.port,
        user: target.username,
        keyType: pending.presented.keyType,
        fingerprintSha256: pending.presented.fingerprintSha256,
      });
    } catch {
      return 'reject';
    }
  }

  private onSnapshot(record: ConnectionRecord, snapshot: ConnectionSnapshot): void {
    this.options.observe?.({
      at: Date.now(),
      connectionId: record.id,
      phase: snapshot.phase,
      retryAttempt: snapshot.retryAttempt,
      transportId: snapshot.connectionId,
      generationId: snapshot.generationId,
      selectedId: snapshot.selectedSession?.id ?? null,
      selectedName: snapshot.selectedSession?.name ?? null,
      selectedTag: snapshot.selectedSession?.tag ?? null,
      error: snapshot.error,
    });
    const state = connectionStateFor(snapshot);
    const attempt = state === 'reconnecting' ? snapshot.retryAttempt : 0;
    if (state === record.lastState && attempt === record.lastAttempt) return;
    record.lastState = state;
    record.lastAttempt = attempt;
    if (state === 'reconnecting') {
      this.emitState(record.id, state, {
        attempt,
        maxAttempts: record.controller.maxReconnectAttempts,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      });
    } else if (state === 'lost' && snapshot.error) {
      this.emitState(record.id, state, { error: snapshot.error });
    } else {
      this.emitState(record.id, state);
    }
  }

  private emitState(
    connectionId: string,
    state: ConnectionState,
    detail: Omit<ConnectionStateEvent, 'connectionId' | 'state'> = {},
  ): void {
    for (const listener of this.stateListeners) listener({ connectionId, state, ...detail });
  }

  private recordOf(connectionId: string): ConnectionRecord {
    const record = this.records.get(connectionId);
    if (!record) throw new Error(`unknown connection: ${connectionId}`);
    return record;
  }
}

/** The refusal a changed host key gets: what changed, and that nothing connected. */
export function hostKeyChangedMessage(hostLabel: string, pending: PendingHostKeyDecision | null): string {
  const presented = pending?.presented.fingerprintSha256;
  const trusted = pending?.previouslyTrusted?.fingerprintSha256;
  const detail = presented
    ? ` It now presents ${presented}${trusted ? ` instead of the trusted ${trusted}` : ''}.`
    : '';
  return `Host key for ${hostLabel} has changed — connection refused.${detail} `
    + 'This can mean the server was reinstalled or that someone is intercepting the connection.';
}

/** Normalize a native bridge failure into the message the shared app shows. */
export function nativeErrorMessage(error: unknown): string {
  return readSshCapabilityError(error).message;
}
