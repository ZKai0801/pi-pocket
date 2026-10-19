/**
 * The narrow seam between the projects tab and the Pi surface of whatever
 * currently owns the phone's one live SSH connection (Task 7's R9 ruling).
 * The projects store reaches the remote session directories through this
 * port rather than coupling to the shell's session owner: the single shell
 * installs its live Pi port here once it owns the session, and the store
 * only ever sees `transport()` / `remoteContext()` / `listDirectories(path)`.
 */
import type { PiTransport } from '../pi/piRepository';

/** A subdirectory entry of the native `sftpList` listing (directories only). */
export interface PiDirectoryEntry {
  name: string;
  path: string;
}

/** The remote environment the session-root probe needs. */
export interface PiRemoteContext {
  home: string;
  env: Record<string, string | undefined>;
}

export interface PiLive {
  /** The live connection's Pi transport (exec + sftpRead). */
  transport(): PiTransport;
  /** The live connection's remote $HOME and process environment. */
  remoteContext(): Promise<PiRemoteContext>;
  /** The subdirectories of the remote directory, sorted by name. */
  listDirectories(path: string): Promise<PiDirectoryEntry[]>;
}

let installed: PiLive | null = null;

/**
 * Hand the shell's live Pi surface to the projects store. Called by the
 * single phone shell when it takes ownership of the session; pass null to
 * hand it back.
 */
export function installPiLive(live: PiLive | null): void {
  installed = live;
}

/**
 * The installed live surface, resolved lazily at discovery time so the store
 * can be built before the shell has claimed a connection. Throws when no
 * shell owns one — the store turns that into `state: 'error'`, never a crash.
 */
export function piLive(): PiLive {
  if (!installed) throw new Error('No live connection owner is installed yet.');
  return installed;
}
