/**
 * The narrow seam between the terminal secondary screen and whatever
 * currently owns the phone's one live SSH connection. The screen dials the
 * PTY through this port rather than coupling to the session owner: the
 * single shell installs its terminal PTY here once it owns the session
 * (attach by name, the data pump, writes, resize, detach), and the screen
 * only ever sees `attach(name, geometry)` / `onData(cb)` / `write(data)` /
 * `resize(cols, rows)` / `detach()`.
 */
import type { TerminalGeometry } from '../terminalGeometry';

export interface TerminalPty {
  /** Open the PTY attached to the named aplexer session (core `buildAttachCommand`). */
  attach(sessionName: string, geometry: TerminalGeometry): Promise<{ ok: boolean; error?: string }>;
  /** Stream PTY output as decoded text chunks; `detach()` stops the stream. */
  onData(callback: (data: string) => void): void;
  /** Send terminal input to the attached PTY. */
  write(data: string): Promise<void>;
  /** Resize the attached PTY to the viewport's grid. */
  resize(cols: number, rows: number): Promise<void>;
  /** Close the PTY and stop the pump. Idempotent. */
  detach(): Promise<void>;
}

let installed: TerminalPty | null = null;

/**
 * Hand the shell's terminal PTY to the terminal screen. Called by the single
 * phone shell when it takes ownership of the session; pass null to hand it
 * back.
 */
export function installTerminalPty(pty: TerminalPty | null): void {
  installed = pty;
}

/**
 * The installed PTY, resolved lazily at attach time so the screen can be
 * built before the shell has claimed a connection. Throws when no shell
 * owns one — the screen turns that into an error state, never a crash.
 */
export function terminalPty(): TerminalPty {
  if (!installed) throw new Error('No terminal PTY owner is installed yet.');
  return installed;
}
