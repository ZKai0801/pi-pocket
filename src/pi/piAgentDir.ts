/**
 * Where this host's Pi agent directory actually lives, for the command sheet's
 * probe and every other scan that must not assume `~/.pi/agent`.
 *
 * pi relocates its whole agent tree — `extensions/`, `packages/`, `prompts/`,
 * `skills/` — with `PI_CODING_AGENT_DIR`. A host that sets it (Nix-managed
 * layouts do) keeps its extension commands in a directory the historical
 * hardcoded probe never read, and the sheet silently showed built-ins only:
 * pi exposes no command-list RPC, so a scan of the wrong tree answers
 * "nothing" with exit 0 and no explanation.
 *
 * Discovery is therefore evidence-driven and cached per host:
 *
 * 1. `PI_CODING_AGENT_DIR` as this app's exec channel sees it — the env of the
 *    very shell a PocketShell-driven pi would run in.
 * 2. The same variable as an interactive login shell sees it (`bash -l -c`):
 *    rc files are exactly where custom layouts are usually declared, and every
 *    shell this app drives is a non-login one (see `piNodePathPrelude`).
 * 3. The parent of the session root this app already resolved — pi's default
 *    layout nests sessions as `<agent>/sessions`, so a session root that was
 *    probed or user-configured points straight at its agent directory.
 *
 * The results are extra roots only: the caller's scan keeps `~/.pi/agent` and
 * the project's `.pi` on its own, so a failed or empty discovery changes
 * nothing about what worked before.
 */
import type { PiTransport } from './piRepository';
import { quoteShell } from './piCommands';
import { rememberedSessionRoot } from './lastSessionRoot';

export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** First line of {@link piAgentDirProbeCommand}: lets a mock host recognise it. */
export const PI_AGENT_DIR_PROBE_MARKER = '# pi-agent-dir-probe';

const PROBE_TIMEOUT_MS = 15_000;

/** One exec answering both env readings. POSIX; `bash -l -c` is optional. */
export function piAgentDirProbeCommand(): string {
  const loginScript = `printf 'login=%s\\n' "\${${PI_AGENT_DIR_ENV}-}"`;
  return [
    PI_AGENT_DIR_PROBE_MARKER,
    `printf 'env=%s\\n' "\${${PI_AGENT_DIR_ENV}-}"`,
    `command -v bash >/dev/null 2>&1 && bash -l -c ${quoteShell(loginScript)} 2>/dev/null`,
    'true',
  ].join('\n');
}

export interface PiAgentDirProbeAnswer {
  /** The variable as the exec channel's own environment has it. */
  env: string | null;
  /** The variable as an interactive login shell would have it. */
  login: string | null;
}

/** Read the probe's `env=` / `login=` lines; absent or empty values stay null. */
export function parsePiAgentDirProbe(stdout: string): PiAgentDirProbeAnswer {
  let env: string | null = null;
  let login: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('env=') && env === null) {
      const value = line.slice('env='.length).trim();
      if (value !== '') env = value;
    } else if (line.startsWith('login=') && login === null) {
      const value = line.slice('login='.length).trim();
      if (value !== '') login = value;
    }
  }
  return { env, login };
}

/** The directory above `path`, the way pi's default layout nests sessions. */
function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

/** Absolute, no NUL/newline: a value pi could actually `cd` into. */
function plausibleRoot(value: string): boolean {
  return value.startsWith('/') && !/[\n\r\0]/u.test(value);
}

/**
 * The extra agent roots to scan, in evidence order, deduped. Only values that
 * could be directories survive; the default `~/.pi/agent` is deliberately NOT
 * added here — the probe command keeps it unconditionally, so an empty answer
 * means "scan exactly what you scanned before".
 */
export function agentDirRoots(
  answer: Partial<PiAgentDirProbeAnswer> & { sessionRoot?: string | null },
): string[] {
  const sessionRootParent = answer.sessionRoot !== undefined && answer.sessionRoot !== null
    ? parentDirectory(answer.sessionRoot)
    : null;
  const candidates = [answer.env ?? null, answer.login ?? null, sessionRootParent];
  const roots: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed === undefined || trimmed === '' || !plausibleRoot(trimmed)) continue;
    if (!roots.includes(trimmed)) roots.push(trimmed);
  }
  return roots;
}

export interface PiAgentDirResolution {
  /** Extra roots to scan this host with; possibly empty, never null. */
  roots: string[];
  /** The two env readings, for the sheet's failure notice and tests. */
  answer: PiAgentDirProbeAnswer;
}

/**
 * Ask the host where its agent tree lives. Never throws: a probe that cannot
 * run (no bash, a transport fault) still yields the session-root parent, and
 * an answer of "nowhere extra" is a valid, cached result.
 */
export async function resolvePiAgentRoots(
  transport: PiTransport,
  hints: { sessionRoot?: string | null },
): Promise<PiAgentDirResolution> {
  let answer: PiAgentDirProbeAnswer = { env: null, login: null };
  try {
    const result = await transport.exec(piAgentDirProbeCommand(), PROBE_TIMEOUT_MS);
    answer = parsePiAgentDirProbe(result.stdout);
  } catch {
    // The transport fault is not this resolver's to report: the caller's own
    // probe will surface it, and the session-root hint below still applies.
  }
  return { roots: agentDirRoots({ ...answer, sessionRoot: hints.sessionRoot ?? null }), answer };
}

/* ------------------------------------------------------------- host cache */

/**
 * The extra roots a host last answered, next to the session root they were
 * derived under — a session root that moved invalidates them, since the
 * parent-dir evidence moved with it. Same storage seam shape as
 * `lastSessionRoot`, for the same testability reasons.
 */

export const AGENT_ROOTS_STORAGE_KEY = 'pocketshell.pi.agent-roots.v1';

export interface AgentRootsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let installedStorage: AgentRootsStorage | null = null;

/** Install the durable store; null falls back to `localStorage` when present. */
export function installAgentRootsStorage(storage: AgentRootsStorage | null): void {
  installedStorage = storage;
}

function storage(): AgentRootsStorage | null {
  if (installedStorage) return installedStorage;
  try {
    const ls = (globalThis as { localStorage?: AgentRootsStorage }).localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null;
  }
}

interface AgentRootsRecord {
  [hostName: string]: { roots: string[]; sessionRoot: string };
}

function readRecord(): AgentRootsRecord {
  const raw = storage()?.getItem(AGENT_ROOTS_STORAGE_KEY) ?? null;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record: AgentRootsRecord = {};
  for (const [hostName, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && Array.isArray((entry as { roots?: unknown }).roots)
      && ((entry as { roots: unknown }).roots as unknown[]).every((root) => typeof root === 'string')
      && typeof (entry as { sessionRoot?: unknown }).sessionRoot === 'string'
    ) {
      record[hostName] = {
        roots: (entry as { roots: string[] }).roots,
        sessionRoot: (entry as { sessionRoot: string }).sessionRoot,
      };
    }
  }
  return record;
}

function writeRecord(record: AgentRootsRecord): void {
  try {
    storage()?.setItem(AGENT_ROOTS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable or full; remembering is best-effort.
  }
}

/** Remember the roots answered for `hostName` under its current session root. */
export function rememberAgentRoots(
  hostName: string | null | undefined,
  sessionRoot: string | null | undefined,
  roots: readonly string[],
): void {
  if (!hostName) return;
  const record = readRecord();
  record[hostName] = { roots: [...roots], sessionRoot: sessionRoot ?? '' };
  writeRecord(record);
}

/**
 * The cached roots for `hostName`, or null when none are remembered or the
 * session root they were derived under no longer matches.
 */
export function cachedAgentRoots(
  hostName: string | null | undefined,
  sessionRoot: string | null | undefined,
): string[] | null {
  if (!hostName) return null;
  const entry = readRecord()[hostName];
  if (entry === undefined || entry.sessionRoot !== (sessionRoot ?? '')) return null;
  return [...entry.roots];
}

/* ------------------------------------------------- per-host in-flight map */

const inFlight = new Map<string, Promise<PiAgentDirResolution>>();

/**
 * Resolve this host's extra agent roots once per session root: the durable
 * cache answers repeats, an in-flight promise coalesces concurrent sheet
 * opens, and a miss runs the probe and remembers the answer.
 */
export async function agentRootsForHost(
  transport: PiTransport,
  host: { name: string | null; sessionRoot: string | null },
): Promise<PiAgentDirResolution> {
  const key = `${host.name ?? ''}|${host.sessionRoot ?? ''}`;
  const cached = cachedAgentRoots(host.name, host.sessionRoot);
  if (cached !== null) return { roots: cached, answer: { env: null, login: null } };
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<PiAgentDirResolution> => {
    try {
      const resolution = await resolvePiAgentRoots(transport, {
        sessionRoot: host.sessionRoot,
      });
      rememberAgentRoots(host.name, host.sessionRoot, resolution.roots);
      return resolution;
    } finally {
      // Only this call owns the key until it settles: a later caller finds the
      // entry present and joins this promise, so the delete is unconditional.
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** A saved host, as far as agent-root discovery cares about it. */
export interface AgentRootsHost {
  name: string | null;
  piSessionsDir?: string | null;
}

/**
 * The session-root hint for a host: its configured override, else the root its
 * last successful connect resolved. Override first, because that is the value
 * the app itself uses when it resolves sessions next.
 */
export function sessionRootHintForHost(host: AgentRootsHost): string | null {
  const override = host.piSessionsDir?.trim();
  if (override !== undefined && override.length > 0) return override;
  return rememberedSessionRoot(host.name);
}

/**
 * Resolve a connected host's extra agent roots: the connect flow warms this
 * once per host (the durable cache inside makes every later connect a pure
 * cache read), and the command sheet reads the same cache when it opens.
 */
export async function agentRootsForConnection(
  transport: PiTransport,
  host: AgentRootsHost,
): Promise<PiAgentDirResolution> {
  return agentRootsForHost(transport, {
    name: host.name,
    sessionRoot: sessionRootHintForHost(host),
  });
}
