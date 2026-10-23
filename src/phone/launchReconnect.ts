/**
 * The phone's launch-time "dial the host you were last on?" decision.
 *
 * The phone twin of core's `autoConnect.ts`, kept here rather than imported
 * because the phone owns its host list (`SavedHost`, keyed by `name`) while
 * core's shared decision is typed on `HostEntry`. The rules are deliberately
 * the same, because the failure mode is the same: an automatic dial that
 * re-decides on every mount traps the user in a reconnect loop they did not
 * ask for, and one that fires over a live connection bounces them straight
 * back into the session they just left.
 *
 * It is a pure function plus a module-level latch so it can be tested without
 * a device, a Pinia store or a WebView.
 */

/** Why no dial happened; the caller may log or ignore it. */
export type LaunchSkipReason =
  /** Already tried once this launch: every later mount is the user's own navigation. */
  | 'already-attempted'
  /** A connection is already live — a resume or a Back, not a cold start. */
  | 'already-connected'
  /** The saved hosts have not loaded yet; decide again when they have. */
  | 'no-hosts'
  /** Nothing was ever connected on this phone, so there is nothing to return to. */
  | 'no-last-host'
  /** The remembered host was renamed or deleted since; a plain skip, never an error. */
  | 'unknown-host';

export interface LaunchReconnectInput {
  /** The remembered host's identity, as written after the last successful dial. */
  lastHost: string | null;
  /** The saved host names, as the connections store reports them — already loaded. */
  hostNames: readonly string[];
  /** {@link launchReconnectAttempted} at the moment of the decision. */
  attempted: boolean;
  /** True when a host is already connected or dialling. */
  connected: boolean;
}

export type LaunchReconnectDecision =
  | { action: 'connect'; name: string }
  | { action: 'skip'; reason: LaunchSkipReason };

/**
 * Decide whether to dial, and what.
 *
 * The order encodes the escape hatches:
 *   1. `attempted` first, so this can only ever fire ONCE per launch. A failed
 *      dial, a cancelled host-key prompt or a Back afterwards must not re-dial.
 *   2. `connected` next, so a shell that already owns a session never dials a
 *      second one over it.
 *   3. `no-hosts` is not a decision but a deferral: the phone's host list loads
 *      from a dynamic import, so a mount that beats it must try again when the
 *      list arrives rather than latch on an empty list forever.
 *   4. Only then is the remembered host consulted, and a name that is gone is
 *      a skip: a host can be renamed or deleted at any time.
 */
export function decideLaunchReconnect(input: LaunchReconnectInput): LaunchReconnectDecision {
  if (input.attempted) return { action: 'skip', reason: 'already-attempted' };
  if (input.connected) return { action: 'skip', reason: 'already-connected' };
  if (input.hostNames.length === 0) return { action: 'skip', reason: 'no-hosts' };
  const name = input.lastHost?.trim();
  if (!name) return { action: 'skip', reason: 'no-last-host' };
  if (!input.hostNames.includes(name)) return { action: 'skip', reason: 'unknown-host' };
  return { action: 'connect', name };
}

/**
 * The once-per-launch latch, at module scope for the same reason core's is:
 * it must be tied to the lifetime of the loaded document and nothing else. A
 * WebView reload re-evaluates the module, which is correct — a reload IS a
 * fresh launch, and Android hands us one whenever it recycles the process,
 * which is exactly when the user wants their session back.
 */
let attempted = false;

export function launchReconnectAttempted(): boolean {
  return attempted;
}

/**
 * Latch BEFORE dialling, never after: a dial that throws, hangs or stops at a
 * host-key prompt still happened, and repeating it on the next mount is how a
 * bad remembered host becomes a loop the user cannot escape.
 */
export function markLaunchReconnectAttempted(): void {
  attempted = true;
}

/** Test-only: put the latch back to its launch state. */
export function resetLaunchReconnectLatch(): void {
  attempted = false;
}
