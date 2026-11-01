import { quoteShell } from './piCommands';

/**
 * One long-lived exec channel, and the file watch built on it.
 *
 * Every remote read this app used to make was its own SSH channel: open,
 * request, read to EOF, close. At a 213 ms round trip that is most of a second
 * before a single byte arrives, and the turn loop paid it once a second for
 * as long as a turn ran. A stream is opened once and then only pushes: the
 * host sends bytes the moment they exist, and the phone pays no round trip at
 * all to learn about them.
 *
 * The channel is a plain exec — no host-side installation — so it keeps D45's
 * contract (SSH + `pi`; no helper CLI) and works on any POSIX host.
 */

/** One pushed piece of a stream: bytes, or the channel's end. */
export interface PiStreamChunk {
  /** Decoded output. Absent on the final chunk. */
  text?: string;
  /** True once the remote command's channel is finished; no more chunks follow. */
  done: boolean;
  /** The remote exit status, when the host reported one. */
  exitCode?: number | null;
}

/** What a caller can do with an open channel. */
export interface PiStreamHandle {
  close(): Promise<void>;
}

/**
 * The platform seam: open a channel and receive its output as it arrives.
 * `null` means this platform cannot stream (the browser dev bridge, a build
 * without the native transport), and the caller falls back to polling.
 */
export interface PiStreamSource {
  open(command: string, onChunk: (chunk: PiStreamChunk) => void): Promise<PiStreamHandle | null>;
}

/**
 * Follow a session file from its first line and keep following it: `tail`
 * prints what is already there, then whatever pi appends.
 *
 * `-F` (follow by name, retry) rather than `-f` because a draft's file does
 * not exist yet when the turn starts — pi writes it on the first message — and
 * a `-f` on a missing file exits instead of waiting for it.
 */
export function sessionWatchCommand(path: string): string {
  return `tail -F -n +1 -- ${quoteShell(path)}`;
}

export interface PiSessionWatch {
  /** Everything the watch has received so far, from the file's first byte. */
  text(): string;
  /**
   * Wait for the file to have grown. Resolves true when it has (the caller
   * re-reads {@link text}), false on timeout. A closed watch resolves false
   * immediately and forever: nothing more can arrive on it.
   */
  waitForChange(timeoutMs: number): Promise<boolean>;
  /** True once the channel is finished. */
  readonly closed: boolean;
  close(): void;
}

export interface PiSessionWatchOptions {
  /**
   * How long a burst of appends is collected before the waiter is woken.
   * Pi writes several entries in a row (text, then tool calls, then results);
   * without this each one would wake a full re-parse.
   */
  coalesceMs?: number;
}

type Waiter = (changed: boolean) => void;

/**
 * Open a follow on `path`. Resolves null when the platform cannot stream, so
 * every caller has a fallback and none has to know why.
 */
export async function watchSessionFile(
  source: PiStreamSource,
  path: string,
  options: PiSessionWatchOptions = {},
): Promise<PiSessionWatch | null> {
  const coalesceMs = options.coalesceMs ?? 120;
  let text = '';
  let changed = false;
  let closed = false;
  let disposed = false;
  const waiters = new Set<Waiter>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let handle: PiStreamHandle | null = null;

  const resolveAll = (value: boolean): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const pending = [...waiters];
    waiters.clear();
    for (const waiter of pending) waiter(value);
  };

  const flush = (): void => {
    if (!changed) return;
    changed = false;
    resolveAll(true);
  };

  const onChunk = (chunk: PiStreamChunk): void => {
    if (disposed) return;
    if (chunk.text) {
      text += chunk.text;
      changed = true;
      if (coalesceMs <= 0) flush();
      else if (timer === null) timer = setTimeout(flush, coalesceMs);
    }
    if (chunk.done) {
      closed = true;
      // A close with pending bytes is still a change: the caller must see the
      // last entries before it decides the watch is finished.
      if (changed) flush();
      else resolveAll(false);
    }
  };

  try {
    handle = await source.open(sessionWatchCommand(path), onChunk);
  } catch {
    return null;
  }
  if (handle === null) return null;

  return {
    text: () => text,
    get closed() {
      return closed;
    },
    waitForChange(timeoutMs: number): Promise<boolean> {
      if (closed || disposed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          waiters.delete(finish);
          resolve(value);
        };
        const deadline = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        waiters.add(finish);
      });
    },
    close(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      resolveAll(false);
      const open = handle;
      handle = null;
      if (open) void open.close();
    },
  };
}
