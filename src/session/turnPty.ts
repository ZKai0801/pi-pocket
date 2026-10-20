/**
 * The narrow seam between the Pi turn runner and whatever currently owns the
 * phone's one live SSH connection. A turn needs its own PTY running
 * `pi --session <file>` in the chat's project directory, separate from the
 * terminal screen's attach PTY. The shell installs the opener once it owns the
 * session and releases it on unmount; the runner only ever sees
 * `open(command, geometry)` and the returned handle.
 */
export interface TurnPtyGeometry {
  cols: number;
  rows: number;
}

export interface TurnPtyHandle {
  /** Stream decoded output chunks; the returned function unsubscribes. */
  onData(callback: (chunk: string) => void): () => void;
  /** Send terminal input to the turn PTY. */
  write(data: string): void;
  /** Close the PTY and stop its pump. Idempotent. */
  close(): void;
}

export interface TurnPtyOpener {
  /** Open a PTY running `command`; `openPty` has no cwd, so the caller `cd`s. */
  open(command: string, geometry: TurnPtyGeometry): Promise<TurnPtyHandle>;
}

let installed: TurnPtyOpener | null = null;

/**
 * Hand the shell's turn-PTY opener to the runner. Called by the phone shell
 * when it takes ownership of the connection; pass null to hand it back.
 */
export function installTurnPtyOpener(opener: TurnPtyOpener | null): void {
  installed = opener;
}

/**
 * The installed opener, resolved lazily at send time so the runner can be
 * built before the shell has claimed a connection. Throws when no shell owns
 * one — the caller turns that into an error state, never a crash.
 */
export function turnPtyOpener(): TurnPtyOpener {
  if (!installed) throw new Error('No turn terminal opener is installed yet.');
  return installed;
}
