/**
 * The narrow seam between the chat composer and whatever currently owns the
 * phone's one live SSH connection (#2857). The composer reaches the host's
 * attachment staging directory through this port rather than coupling to the
 * shell's connection owner — the same shape `piLive` and `connectionPort`
 * already use, and for the same reason: the composer must stay renderable (and
 * testable) with no connection installed.
 *
 * ## Why one verb and not three
 *
 * Core's `PocketShellApi['attachments']` splits picking from staging because a
 * desktop can pick a file, keep it in a tile, and stage it later. The phone
 * cannot: a SAF grant is a live resource that only the native handle table
 * holds, so a pick that is not staged before the table evicts it is a pick the
 * user has to repeat. `attach` therefore means "pick and stage, in one go",
 * and a cancel is an empty success rather than an error.
 *
 * ## Why the result is not thrown
 *
 * The contract for `stage` is "never thrown", so a failure is a value the
 * composer renders under a draft it keeps. Only a missing connection owner
 * throws, and only at tap time — a tap with no connection answers with an
 * error the user can read.
 */

/** What one attach tap produced. */
export interface ComposerAttachOutcome {
  /**
   * Tilde-form remote paths, in pick order. A partial failure keeps the files
   * that did land — they are attached, and dropping them would lose uploads
   * the user already paid for.
   */
  paths: string[];
  /** Safe to show verbatim; null when nothing went wrong (a cancel included). */
  error: string | null;
}

/** One acknowledged upload step, as the composer's progress line needs it. */
export interface ComposerAttachProgress {
  fileName: string;
  /** 1-based, for "3 of 5". */
  fileIndex: number;
  fileCount: number;
  batchBytesWritten: number;
  batchBytesTotal: number;
}

export interface ComposerAttachLive {
  /**
   * Pick files with the system picker and stage them under
   * `~/.pocketshell/attachments/<scopeKey>/`. A cancelled pick resolves with
   * no paths and no error; a partial failure keeps the paths that landed.
   *
   * `onProgress` fires on each acknowledged chunk write — never on a timer, so
   * the bar cannot advance while the link is stalled.
   */
  attach(options: {
    scopeKey: string;
    onProgress?: (progress: ComposerAttachProgress) => void;
  }): Promise<ComposerAttachOutcome>;
}

let installed: ComposerAttachLive | null = null;

/**
 * Hand the shell's attachment surface to the composer. Called by the single
 * phone shell once it owns a connection; pass null to hand it back.
 */
export function installComposerAttach(live: ComposerAttachLive | null): void {
  installed = live;
}

/**
 * The installed surface, resolved lazily at tap time so the composer can be
 * built before the shell has claimed a connection. Throws when no shell owns
 * one — the composer turns that into an error line, never a crash.
 */
export function composerAttach(): ComposerAttachLive {
  if (!installed) throw new Error('No live connection owner is installed yet.');
  return installed;
}
