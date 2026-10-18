/**
 * The narrow seam between a host list and whatever currently owns the phone's
 * one live SSH connection (#D8). The connections store dials through this port
 * rather than coupling to the large core `ConnectionController`: the single
 * shell installs its live-connection port here once it owns the session, and
 * the store only ever sees `connect(target)` / `disconnect()`.
 */
import type { SshHostTarget } from '@pocketshell/core';

export interface ConnectionPort {
  /** Dial a resolved host; a rejected dial means the connection is not up. */
  connect(target: SshHostTarget): Promise<{ ok: boolean }>;
  /** Close whatever connection the port currently owns, if any. */
  disconnect(): Promise<void>;
}

let installed: ConnectionPort | null = null;

/**
 * Hand the shell's live connection to the connections store. Called by the
 * single phone shell when it takes ownership of the session.
 */
export function installConnectionPort(port: ConnectionPort): void {
  installed = port;
}

/**
 * The installed port, resolved lazily at dial time so the store can be built
 * before the shell has claimed a connection. Throws when no shell owns one —
 * the store turns that into `status: 'error'`, never a crash.
 */
export function connectionPort(): ConnectionPort {
  if (!installed) throw new Error('No live connection owner is installed yet.');
  return installed;
}
