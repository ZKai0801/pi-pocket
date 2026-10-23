/**
 * Local backup of a project's Pi session list (the 会话 tab's rows).
 *
 * `PiRepository.listSessions` is the slowest read in the app: one `find` for
 * the project's directory, then a `tail` exec per session file to get the
 * name and preview. A project with thirty conversations is thirty SSH round
 * trips, so entering it from the 项目 tab used to sit on 正在加载会话… while the
 * phone walked them one by one. The backup paints the last confirmed rows
 * immediately and the server's listing replaces them when it lands, so a
 * reconnect shows the conversations at once and only their freshness is late.
 *
 * The backup is a cache, never a source of truth: every load still lists the
 * server, and the painted rows are only ever shown while that listing is in
 * flight or after it failed. Keyed by host AND project path — two hosts may
 * hold different session roots, and two projects never share rows — with a
 * TTL and a list cap so a phone that talks to many hosts cannot accumulate
 * them forever.
 */
import type { PiSessionMeta } from './piRepository';

/** Bumped when the stored shape changes; older entries are discarded. */
export const SESSION_LIST_CACHE_SCHEMA = 1;

export interface CachedSessionList {
  /** The host the rows were read on. */
  host: string;
  /** The project directory the rows belong to. */
  projectPath: string;
  schema: number;
  sessions: PiSessionMeta[];
  /** When this list was last confirmed by a server listing. */
  savedAtMs: number;
}

/** The identity of one cached list: a project on a host. */
export interface SessionListKey {
  host: string;
  projectPath: string;
}

export interface SessionListCacheStorage {
  all(): Promise<CachedSessionList[]>;
  put(entry: CachedSessionList): Promise<void>;
  delete(key: SessionListKey): Promise<void>;
}

export interface SessionListCachePolicy {
  /** Rows not confirmed by the server for this long are dropped. */
  ttlMs: number;
  /** Hard cap on remembered lists; the least recently confirmed are dropped. */
  maxLists: number;
  /**
   * Rows kept per list. The paint is a placeholder for a listing that is
   * already in flight, so a very long project is truncated rather than
   * allowed to bloat localStorage (which is shared with the project cache).
   */
  maxSessions: number;
}

export const DEFAULT_SESSION_LIST_CACHE_POLICY: SessionListCachePolicy = {
  // Conversations change far more often than projects do, and every failed
  // sync after this window falls back to the plain "loading" it replaced —
  // so the backup expires sooner than the project list's 30 days.
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  maxLists: 16,
  maxSessions: 200,
};

function sameKey(left: SessionListKey, right: SessionListKey): boolean {
  return left.host === right.host && left.projectPath === right.projectPath;
}

export function isSessionListCacheEntryExpired(
  entry: CachedSessionList,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - entry.savedAtMs > ttlMs;
}

/** The lists a sweep should delete: every expired entry, then the oldest past `maxLists`. */
export function selectSessionListCacheEvictions(
  entries: readonly CachedSessionList[],
  nowMs: number,
  policy: SessionListCachePolicy,
): SessionListKey[] {
  const expired = entries
    .filter((entry) => isSessionListCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .map((entry) => ({ host: entry.host, projectPath: entry.projectPath }));
  const live = entries
    .filter((entry) => !isSessionListCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .sort((left, right) => right.savedAtMs - left.savedAtMs)
    .slice(Math.max(0, policy.maxLists))
    .map((entry) => ({ host: entry.host, projectPath: entry.projectPath }));
  return [...expired, ...live];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row this build can still render: the same fields the list shows. */
function isSessionMeta(value: unknown): value is PiSessionMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.id === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    typeof value.updatedAtMs === 'number' &&
    Number.isFinite(value.updatedAtMs) &&
    (typeof value.preview === 'string' || value.preview === null) &&
    typeof value.turnCount === 'number' &&
    Number.isFinite(value.turnCount)
  );
}

/** A stored entry this build can still use: current schema, parseable shape. */
export function isUsableSessionListCacheEntry(value: unknown): value is CachedSessionList {
  return (
    isRecord(value) &&
    value.schema === SESSION_LIST_CACHE_SCHEMA &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    typeof value.projectPath === 'string' &&
    value.projectPath.length > 0 &&
    typeof value.savedAtMs === 'number' &&
    Number.isFinite(value.savedAtMs) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSessionMeta)
  );
}

/** Keep only what the row renders: a preview may be long, the shape is fixed. */
function toMeta(session: PiSessionMeta): PiSessionMeta {
  return {
    path: session.path,
    id: session.id,
    name: session.name,
    updatedAtMs: session.updatedAtMs,
    preview: session.preview,
    turnCount: session.turnCount,
  };
}

export class SessionListsCache {
  constructor(
    private readonly storage: SessionListCacheStorage,
    private readonly policy: SessionListCachePolicy = DEFAULT_SESSION_LIST_CACHE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The backup rows for one project on one host, or null. Never throws. An
   * empty list is a miss, not a hit: the 会话 tab's empty state is a claim
   * about the project, and painting "no conversations" over a listing that is
   * still in flight would be wrong in the one direction the user cannot see.
   */
  async load(host: string | null, projectPath: string | null): Promise<PiSessionMeta[] | null> {
    // Rows are only meaningful for the host and project they were read in:
    // with either missing there is nothing to key them by, so stay silent.
    if (host === null || host === '' || projectPath === null || projectPath === '') return null;
    const key: SessionListKey = { host, projectPath };
    try {
      const entry = (await this.storage.all()).find((candidate) => sameKey(candidate, key));
      if (entry === undefined || !isUsableSessionListCacheEntry(entry)) return null;
      if (isSessionListCacheEntryExpired(entry, this.now(), this.policy.ttlMs)) {
        await this.storage.delete(key).catch(() => undefined);
        return null;
      }
      if (entry.sessions.length === 0) return null;
      return entry.sessions.slice(0, this.policy.maxSessions).map(toMeta);
    } catch {
      return null;
    }
  }

  /** Remember a fresh server listing. A failed write must never fail the load. */
  async save(
    host: string | null,
    projectPath: string | null,
    sessions: readonly PiSessionMeta[],
  ): Promise<void> {
    if (host === null || host === '' || projectPath === null || projectPath === '') return;
    try {
      await this.storage.put({
        host,
        projectPath,
        schema: SESSION_LIST_CACHE_SCHEMA,
        sessions: sessions.slice(0, this.policy.maxSessions).map(toMeta),
        savedAtMs: this.now(),
      });
      await this.sweep();
    } catch {
      // Storage may be full or unavailable; the live list still stands.
    }
  }

  /** Forget one project's backup (its rows may name a root that no longer applies). */
  async clear(host: string | null, projectPath: string | null): Promise<void> {
    if (host === null || host === '' || projectPath === null || projectPath === '') return;
    await this.storage.delete({ host, projectPath }).catch(() => undefined);
  }

  /**
   * Forget every project's backup on one host: its session root was just
   * re-pointed, so every painted path under the old root is wrong, not merely
   * old — and tapping one would open a file that is not there.
   */
  async clearHost(host: string | null): Promise<void> {
    if (host === null || host === '') return;
    try {
      const entries = await this.storage.all();
      for (const entry of entries) {
        if (entry.host === host) {
          await this.storage.delete({ host: entry.host, projectPath: entry.projectPath });
        }
      }
    } catch {
      // A store that cannot be read leaves the entries as they were.
    }
  }

  /** Apply the retention policy; safe to call often, cheap when nothing is due. */
  async sweep(): Promise<void> {
    try {
      const entries = await this.storage.all();
      for (const key of selectSessionListCacheEvictions(entries, this.now(), this.policy)) {
        await this.storage.delete(key);
      }
    } catch {
      // A sweep that cannot read the store leaves it as it was.
    }
  }
}

/** In-memory storage: tests, and any environment without localStorage. */
export function createMemorySessionListCacheStorage(): SessionListCacheStorage {
  const entries = new Map<string, CachedSessionList>();

  function idOf(key: SessionListKey): string {
    return `${key.host}\n${key.projectPath}`;
  }

  return {
    async all() {
      return [...entries.values()];
    },
    async put(entry) {
      entries.set(idOf(entry), entry);
    },
    async delete(key) {
      entries.delete(idOf(key));
    },
  };
}

/** The single localStorage key holding every host's lists as one record. */
export const SESSION_LISTS_CACHE_STORAGE_KEY = 'pocketshell.android.pi.sessionListsCache.v1';

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * The phone's durable storage: rows are small (a path, a name, a one-line
 * preview), so localStorage holds them like the project list — the parsed
 * conversations in `sessionCache` need IndexedDB only because a transcript is
 * orders of magnitude larger. Returns null where localStorage is unavailable;
 * the caller then keeps the cache in memory for the life of the page.
 */
export function createLocalSessionListCacheStorage(
  storage: KeyValueStorage | null = browserStorage(),
): SessionListCacheStorage | null {
  if (!storage) return null;
  // Bound once so the closures below narrow once and keep it.
  const backing: KeyValueStorage = storage;

  function read(): CachedSessionList[] {
    let raw: string | null = null;
    try {
      raw = backing.getItem(SESSION_LISTS_CACHE_STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsableSessionListCacheEntry);
  }

  function write(entries: readonly CachedSessionList[]): void {
    try {
      if (entries.length === 0) backing.removeItem(SESSION_LISTS_CACHE_STORAGE_KEY);
      else backing.setItem(SESSION_LISTS_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // A full or read-only store degrades to no backup, never to an error.
    }
  }

  function idOf(key: SessionListKey): string {
    return `${key.host}\n${key.projectPath}`;
  }

  return {
    async all() {
      return read();
    },
    async put(entry) {
      const key = idOf(entry);
      const entries = read().filter((existing) => idOf(existing) !== key);
      write([...entries, entry]);
    },
    async delete(key) {
      const id = idOf(key);
      write(read().filter((existing) => idOf(existing) !== id));
    },
  };
}

let installedCache: SessionListsCache | null = null;

/** The process-wide backup cache: localStorage where available, memory otherwise. */
export function sessionListsCache(): SessionListsCache {
  if (installedCache === null) {
    installedCache = new SessionListsCache(
      createLocalSessionListCacheStorage() ?? createMemorySessionListCacheStorage(),
    );
  }
  return installedCache;
}

/** Test seam: replace (or, with null, reset) the process-wide cache. */
export function installSessionListsCache(cache: SessionListsCache | null): void {
  installedCache = cache;
}
