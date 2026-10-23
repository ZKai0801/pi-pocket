import {
  ConnectionController as PortableConnectionController,
  type ConnectionControllerOptions,
} from '@pocketshell/core';
import { sshCapability } from '@/native/sshCapability';

export {
  type ConnectionActionResult,
  type ConnectionPhase,
  type ConnectionSnapshot,
  type HostKeyTrustStore,
  type PendingHostKeyDecision,
  type TerminalOutputHandler,
  type UncertainMutation,
} from '@pocketshell/core';

/**
 * The phone's reconnect backoff, in milliseconds between dials.
 *
 * Core's shared ladder (`[0, 250, 500, 1000, 2000]`) spends five dials inside
 * 3.75 s, which is the right shape for a machine whose network is already
 * there. A phone returning from a dark screen is not: Wi-Fi or mobile data
 * takes its own seconds to come back and Doze lifts in stages, so a ladder
 * that short finishes in `lost` before the radio is up, and the user lands on
 * a dead connection they have to reconnect by hand — the exact symptom of
 * losing a session to a screen that was off for a few seconds. Seven dials
 * spread over ~45 s covers that ramp while still settling inside a minute.
 */
export const MOBILE_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000] as const;

/**
 * How long a connection survives the screen going dark: the same window core
 * defaults to, held here as a phone constant rather than a setting.
 *
 * The phone has no background keep-alive — no foreground service, no partial
 * wake lock — so Doze severs the transport on its own schedule and a longer
 * window mostly buys time the platform has already taken back. Returning is
 * covered either way (`returnToForeground` probes the transport and redials; a
 * cold start dials through `launchReconnect`), so this window only decides
 * whether the trip back reuses the connection or spends one redial. Reading a
 * constant also retires the stored toggle: a `false` carried over from 0.5.x
 * would otherwise park the phone on `lost` with no control left to change it.
 */
export const MOBILE_BACKGROUND_GRACE_MS = 90_000;

/** Returning always redials; leaving that to a choice is a desktop concern. */
export const MOBILE_RECONNECT_ON_RETURN = true;

/** Bind the Capacitor SSH plugin to the shared connection/session policy. */
export class ConnectionController extends PortableConnectionController {
  constructor(options: Omit<ConnectionControllerOptions, 'capability'>) {
    super({
      ...options,
      capability: sshCapability,
      retryDelaysMs: options.retryDelaysMs ?? MOBILE_RETRY_DELAYS_MS,
    });
  }
}
