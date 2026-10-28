import type { ParsedPiSession } from './types';
import { parsePiSession, sessionPreview } from './parsePiSession';
import {
  deleteSessionFileCommand,
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  readProjectCwdCommand,
  readSessionLinesCommand,
  readSessionSummariesCommand,
  readSessionSummaryCommand,
  SESSION_SUMMARY_MARKER,
} from './piCommands';

export interface PiTransport {
  exec(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  /**
   * Read a remote text file from its head to EOF — or to `maxBytes`, whichever
   * comes first — in bounded transfers of at most `chunkBytes` (default: the
   * native plugin bound). Returns the decoded text; the caller's parser
   * tolerates a half-written final line.
   */
  sftpRead(path: string, maxBytes: number, chunkBytes?: number): Promise<string>;
}

export interface PiProject {
  path: string;
  name: string;
}

export interface PiSessionMeta {
  path: string;
  id: string;
  name: string | null;
  updatedAtMs: number;
  preview: string | null;
  turnCount: number;
}

export class PiRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiRepositoryError';
  }
}

/**
 * How much of a session file's end one list row reads: enough for the last
 * turns and the preview. The name is NOT limited to this window — it is read
 * from the same exec by its own `session_info` scan (see
 * {@link readSessionSummariesCommand}), because `/name` writes where the user
 * ran it rather than at the end of the file.
 */
const SESSION_TAIL_BYTES = 65536;
/**
 * Bytes per SFTP transfer when reading a whole session file: the transport's
 * own bound, so a big session takes the fewest round trips it can. Each
 * transfer is a phone-to-host hop, and a tool-heavy session is megabytes —
 * half the chunk size is twice the wait before the chat shows its turns.
 */
const SESSION_READ_CHUNK_BYTES = 512 * 1024;
/**
 * Safety bound for one session read. A conversation past this is not a
 * conversation; the parse keeps whatever was read and the chat shows it.
 */
const SESSION_MAX_READ_BYTES = 16 * 1024 * 1024;
/** Lines per exec page in the SFTP-unavailable fallback read. */
const SESSION_READ_LINES = 4096;
const EXEC_TIMEOUT_MS = 15000;
/**
 * How much of one exec's stdout a summary group may spend. The native exec
 * caps a stream at 1 MiB and FAILS the call past it (`MAX_EXEC_OUTPUT_BYTES`
 * in SshCapabilityPlugin), so a group carries only as many files as their
 * tails fit — batching saves round trips, never bytes. Half the cap leaves
 * room for the markers and the name lines.
 */
const SUMMARY_BATCH_BUDGET_BYTES = 512 * 1024;
/** Marker line, path, and the name line a block adds around one tail. */
const SUMMARY_BLOCK_OVERHEAD_BYTES = 1024;
const SUMMARY_BATCH_FILES = Math.max(
  1,
  Math.floor(SUMMARY_BATCH_BUDGET_BYTES / (SESSION_TAIL_BYTES + SUMMARY_BLOCK_OVERHEAD_BYTES)),
);
/**
 * A group is one exec, so its budget follows the group's size instead of
 * restarting per row. It stays bounded: a group whose files are pathological
 * loses its previews, not the list.
 */
const SUMMARY_EXEC_MAX_MS = 60000;
const SUMMARY_EXEC_PER_FILE_MS = 1000;
const SESSION_DIR_PATTERN = /^--.*--$/;

function summariesTimeoutMs(count: number): number {
  return Math.min(SUMMARY_EXEC_MAX_MS, EXEC_TIMEOUT_MS + count * SUMMARY_EXEC_PER_FILE_MS);
}

/**
 * Split {@link readSessionSummariesCommand}'s output into path → summary text.
 * Each block is the marker, the file's path, a newline, then the tail and the
 * name line exactly as the single-file command printed them — so the parse
 * downstream is the same one a row-by-row read fed.
 */
function parseSessionSummaries(stdout: string): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const block of stdout.split(SESSION_SUMMARY_MARKER)) {
    const newline = block.indexOf('\n');
    if (newline === -1) continue;
    const path = block.slice(0, newline).replace(/\r$/, '');
    if (path === '') continue;
    summaries.set(path, block.slice(newline + 1));
  }
  return summaries;
}

function projectNameFromPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * `path` when it names a session file this repository may remove, else null.
 *
 * Deleting is the one destructive call here and it is driven by a remote
 * listing, so the shape is checked rather than trusted: the file must sit
 * exactly one encoded `--cwd--` directory below the session root and end in
 * `.jsonl`. A path that fails this is refused instead of being handed to
 * `rm` — a listing that ever answers something else (a symlink out of the
 * tree, a stray `..`) must not become a deleted file somewhere else on the
 * host.
 */
export function isRemovableSessionFile(root: string, path: string): boolean {
  if (root.length === 0 || path.length === 0) return false;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!path.startsWith(prefix)) return false;
  const parts = path.slice(prefix.length).split('/');
  if (parts.length !== 2) return false;
  const [dir = '', file = ''] = parts;
  if (dir.length === 0 || file.length === 0) return false;
  if (dir === '.' || dir === '..' || file === '.' || file === '..') return false;
  if (dir.includes('\0') || file.includes('\0')) return false;
  return file.endsWith('.jsonl') && file.length > '.jsonl'.length;
}

/** Complete lines in a `head -n` page: a trailing newline closes its last line, the absence of one ends the file. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

export function sessionIdFromPath(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const afterLastUnderscore = file.slice(file.lastIndexOf('_') + 1);
  return afterLastUnderscore.endsWith('.jsonl')
    ? afterLastUnderscore.slice(0, -'.jsonl'.length)
    : afterLastUnderscore;
}

export class PiRepository {
  constructor(
    private readonly transport: PiTransport,
    private readonly sessionRoot: string,
  ) {}

  async listProjects(): Promise<PiProject[]> {
    const listing = await this.transport.exec(listSessionDirsCommand(this.sessionRoot), EXEC_TIMEOUT_MS);
    if (listing.exitCode !== 0) {
      throw new PiRepositoryError(
        `failed to list session directories (exit ${listing.exitCode}): ${listing.stderr.trim()}`,
      );
    }

    // The listing is newest session file first, so a directory's first
    // appearance marks its most recent conversation: de-duplicating in order
    // leaves the projects sorted by the recency of their latest session.
    const dirs: string[] = [];
    const seenDirs = new Set<string>();
    for (const rawLine of listing.stdout.split('\n')) {
      const match = rawLine.match(/^\S+\s+(.+)$/);
      if (!match) continue;
      const file = match[1].trim();
      const slash = file.lastIndexOf('/');
      if (slash <= 0) continue;
      const dir = file.slice(0, slash);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      dirs.push(dir);
    }

    const projects: PiProject[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!SESSION_DIR_PATTERN.test(dir.slice(dir.lastIndexOf('/') + 1))) continue;

      const header = await this.transport.exec(readProjectCwdCommand(dir), EXEC_TIMEOUT_MS);
      const cwd = this.readCwd(header.stdout);
      if (!cwd || seen.has(cwd)) continue;

      seen.add(cwd);
      projects.push({ path: cwd, name: projectNameFromPath(cwd) });
    }
    return projects;
  }

  async listSessions(project: PiProject): Promise<PiSessionMeta[]> {
    const dir = `${this.sessionRoot}/${encodePiCwd(project.path)}`;
    const listing = await this.transport.exec(listSessionFilesCommand(dir), EXEC_TIMEOUT_MS);
    if (listing.exitCode !== 0) {
      // The listing is a `find … | sort -rn` pipeline, so this exit code is `sort`'s, not `find`'s: this guard catches transport-level failures only, while a missing root still reads as an empty list.
      throw new PiRepositoryError(
        `failed to list sessions (exit ${listing.exitCode}): ${listing.stderr.trim()}`,
      );
    }

    // The listing first, every row's summary after it: the two are one exec
    // each, and only the listing's exit code is a verdict — a file that could
    // not be read costs its row's preview, never the list.
    const rows: Array<{ path: string; updatedAtMs: number }> = [];
    for (const rawLine of listing.stdout.split('\n')) {
      const match = rawLine.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      const epoch = Number(match[1]);
      if (!Number.isFinite(epoch)) continue;
      rows.push({ path: match[2].trim(), updatedAtMs: Math.round(epoch * 1000) });
    }
    const summaries = await this.readSummaries(rows.map((row) => row.path));
    const sessions: PiSessionMeta[] = rows.map(({ path, updatedAtMs }) => {
      const parsed = parsePiSession(summaries.get(path) ?? '');
      return {
        path,
        id: sessionIdFromPath(path),
        name: parsed.name,
        updatedAtMs,
        preview: sessionPreview(parsed),
        turnCount: parsed.turns.length,
      };
    });
    // The listing's `sort -rn` already answers newest first; sorting on the
    // parsed timestamps keeps that promise even when the command's order
    // surprises us — `newestSessionFileOnActiveHost` reads `sessions[0]` as
    // exactly that.
    sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    return sessions;
  }

  /**
   * The summary text for every listed file, in as few execs as the output cap
   * allows ({@link SUMMARY_BATCH_FILES} files each).
   *
   * A group the transport fails outright (a dropped channel, a timeout on a
   * huge project) is read row by row instead: slower, but a list whose rows
   * still carry their names is worth the wait. A group that answers short is
   * treated the same way, so a file the shell choked on costs its own read
   * rather than its row's name.
   */
  private async readSummaries(paths: readonly string[]): Promise<Map<string, string>> {
    const summaries = new Map<string, string>();
    for (let start = 0; start < paths.length; start += SUMMARY_BATCH_FILES) {
      const group = paths.slice(start, start + SUMMARY_BATCH_FILES);
      let answered: Map<string, string> | null = null;
      try {
        const batch = await this.transport.exec(
          readSessionSummariesCommand(group, SESSION_TAIL_BYTES),
          summariesTimeoutMs(group.length),
        );
        answered = parseSessionSummaries(batch.stdout);
      } catch {
        answered = null;
      }
      if (answered !== null && answered.size === group.length) {
        for (const [path, text] of answered) summaries.set(path, text);
        continue;
      }
      for (const path of group) {
        const tail = await this.transport.exec(
          readSessionSummaryCommand(path, SESSION_TAIL_BYTES),
          EXEC_TIMEOUT_MS,
        );
        summaries.set(path, tail.stdout);
      }
    }
    return summaries;
  }

  async readSession(path: string): Promise<ParsedPiSession> {
    return parsePiSession(await this.readSessionText(path));
  }

  /**
   * Delete one conversation: remove its session file on the host. There is no
   * undo — the file is the conversation, and pi has no trash. Refuses a path
   * that is not a session file under this repository's root (see
   * {@link isRemovableSessionFile}) rather than deleting it.
   */
  async deleteSession(path: string): Promise<void> {
    if (!isRemovableSessionFile(this.sessionRoot, path)) {
      throw new PiRepositoryError(`refusing to delete a path outside the session root: ${path}`);
    }
    const result = await this.transport.exec(deleteSessionFileCommand(path), EXEC_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new PiRepositoryError(
        `failed to delete session (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  /**
   * The whole session file. The previous single head-anchored 256 KiB read
   * silently dropped everything past it — and in a tool-heavy session that is
   * exactly where the assistant text lives, since thinking/toolCall/toolResult
   * entries (dropped by the parser anyway) dominate the file's bytes. The read
   * is paged in bounded transfers until the file ends.
   */
  private async readSessionText(path: string): Promise<string> {
    try {
      return await this.transport.sftpRead(path, SESSION_MAX_READ_BYTES, SESSION_READ_CHUNK_BYTES);
    } catch {
      return this.readSessionTextViaExec(path);
    }
  }

  /**
   * Exec fallback for when SFTP is unavailable, paged by LINES rather than
   * bytes: a byte range can split a multi-byte UTF-8 character (each page is
   * decoded on its own), a line never can.
   */
  private async readSessionTextViaExec(path: string): Promise<string> {
    const parts: string[] = [];
    let total = 0;
    let startLine = 1;
    for (;;) {
      const page = await this.transport.exec(
        readSessionLinesCommand(path, startLine, SESSION_READ_LINES),
        EXEC_TIMEOUT_MS,
      );
      const text = page.stdout;
      if (text.length === 0) break;
      parts.push(text);
      total += text.length;
      const lines = countLines(text);
      // A short page is the file's end; a page that hits the bound may or may
      // not be, so only the bound ends the loop when the file is still going.
      if (lines < SESSION_READ_LINES || total >= SESSION_MAX_READ_BYTES) break;
      startLine += lines;
    }
    return parts.join('');
  }

  private readCwd(header: string): string | null {
    const first = header.split('\n').find((line) => line.trim());
    if (!first) return null;
    try {
      const entry = JSON.parse(first) as { cwd?: unknown };
      return typeof entry?.cwd === 'string' && entry.cwd ? entry.cwd : null;
    } catch {
      return null;
    }
  }
}
