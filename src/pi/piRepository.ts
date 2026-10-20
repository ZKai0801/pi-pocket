import type { ParsedPiSession } from './types';
import { parsePiSession, sessionPreview } from './parsePiSession';
import {
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  readProjectCwdCommand,
  readSessionTailCommand,
} from './piCommands';

export interface PiTransport {
  exec(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  sftpRead(path: string, maxBytes: number): Promise<string>;
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
const SESSION_FULL_BYTES = 262144;
const EXEC_TIMEOUT_MS = 15000;
const SESSION_DIR_PATTERN = /^--.*--$/;

function projectNameFromPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
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
    let text: string;
    try {
      text = await this.transport.sftpRead(path, SESSION_FULL_BYTES);
    } catch {
      const tail = await this.transport.exec(
        readSessionTailCommand(path, SESSION_FULL_BYTES),
        EXEC_TIMEOUT_MS,
      );
      text = tail.stdout;
    }
    return parsePiSession(text);
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
