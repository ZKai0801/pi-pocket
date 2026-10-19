/**
 * The root a host's Pi surface last resolved on a successful connect (spec
 * §9.1). The Connections editor seeds its "Pi 会话目录" field from this when the
 * host has no saved override, so a fresh connect's probed root is one save
 * away. Kept behind an installable storage seam so it is testable off-device.
 */

export const LAST_SESSION_ROOT_STORAGE_KEY = 'pocketshell.pi.last-session-root.v1';

export interface SessionRootStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let installed: SessionRootStorage | null = null;

/** Install the durable store; null falls back to `localStorage` when present. */
export function installSessionRootStorage(storage: SessionRootStorage | null): void {
  installed = storage;
}

function storage(): SessionRootStorage | null {
  if (installed) return installed;
  try {
    return (globalThis as { localStorage?: SessionRootStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

interface SessionRootRecord {
  [hostName: string]: string;
}

function readRecord(): SessionRootRecord {
  const raw = storage()?.getItem(LAST_SESSION_ROOT_STORAGE_KEY) ?? null;
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record: SessionRootRecord = {};
  for (const [hostName, root] of Object.entries(parsed as Record<string, unknown>)) {
    if (hostName && typeof root === 'string' && root.length > 0) record[hostName] = root;
  }
  return record;
}

/** Remember the root probed for `hostName`; best-effort when storage is unavailable. */
export function rememberSessionRoot(hostName: string | null | undefined, root: string): void {
  if (!hostName || root.length === 0) return;
  const record = readRecord();
  if (record[hostName] === root) return;
  record[hostName] = root;
  try {
    storage()?.setItem(LAST_SESSION_ROOT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable or full; remembering is best-effort.
  }
}

export function rememberedSessionRoot(hostName: string | null | undefined): string | null {
  if (!hostName) return null;
  return readRecord()[hostName] ?? null;
}

/** The editor preload: a saved override wins, else the remembered probed root. */
export function defaultPiSessionsDir(
  savedDir: string | null | undefined,
  hostName: string | null | undefined,
): string {
  if (savedDir && savedDir.trim().length > 0) return savedDir.trim();
  return rememberedSessionRoot(hostName) ?? '';
}

export interface SessionRootHost {
  name?: string | null;
  piSessionsDir?: string | null;
}

/** The host's editor preload, keeping the saved-vs-remembered rule in one place. */
export function piSessionsDirFor(host: SessionRootHost | null | undefined): string {
  return defaultPiSessionsDir(host?.piSessionsDir, host?.name);
}

/** Resolve a root and remember the non-null result for the host that probed it. */
export async function resolveAndRememberRoot(
  hostName: string | null | undefined,
  resolve: () => Promise<string | null>,
): Promise<string | null> {
  const root = await resolve();
  if (root !== null) rememberSessionRoot(hostName, root);
  return root;
}
