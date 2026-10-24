import type { ParsedPiSession } from './types';
import { parsePiSession, sessionPreview } from './parsePiSession';
import {
  deleteSessionFileCommand,
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  readProjectCwdCommand,
  readSessionLinesCommand,
  readSessionTailCommand,
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

const SESSION_TAIL_BYTES = 65536;
/** Bytes per SFTP transfer when reading a whole session file. */
const SESSION_READ_CHUNK_BYTES = 262144;
/**
 * Safety bound for one session read. A conversation past this is not a
 * conversation; the parse keeps whatever was read and the chat shows it.
 */
const SESSION_MAX_READ_BYTES = 16 * 1024 * 1024;
/** Lines per exec page in the SFTP-unavailable fallback read. */
const SESSION_READ_LINES = 4096;
const EXEC_TIMEOUT_MS = 15000;
const SESSION_DIR_PATTERN = /^--.*--$/;

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

    const projects: PiProject[] = [];
    const seen = new Set<string>();
    for (const rawLine of listing.stdout.split('\n')) {
      const dir = rawLine.trim();
      if (!SESSION_DIR_PATTERN.test(dir)) continue;

      const header = await this.transport.exec(
        readProjectCwdCommand(`${this.sessionRoot}/${dir}`),
        EXEC_TIMEOUT_MS,
      );
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

    const sessions: PiSessionMeta[] = [];
    for (const rawLine of listing.stdout.split('\n')) {
      const match = rawLine.match(/^(\S+)\s+(.+)$/);
      if (!match) continue;
      const epoch = Number(match[1]);
      if (!Number.isFinite(epoch)) continue;
      const path = match[2].trim();

      const tail = await this.transport.exec(
        readSessionTailCommand(path, SESSION_TAIL_BYTES),
        EXEC_TIMEOUT_MS,
      );
      const parsed = parsePiSession(tail.stdout);
      sessions.push({
        path,
        id: sessionIdFromPath(path),
        name: parsed.name,
        updatedAtMs: Math.round(epoch * 1000),
        preview: sessionPreview(parsed),
        turnCount: parsed.turns.length,
      });
    }
    return sessions;
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
