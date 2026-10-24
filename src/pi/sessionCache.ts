/**
 * Local backup of opened Pi conversations. The chat paints the last-read
 * parse of a session instantly on a cold start and replaces it with the
 * server's fresh read, so a slow or very large session never blocks the UI
 * (spec §8.6). The backup is a cache, never a source of truth: every open
 * re-reads the server, and the backup is only ever shown while that read is
 * in flight.
 *
 * What is stored is the PARSED session, not the file's bytes: it is an order
 * of magnitude smaller, and the parser stays the single place that interprets
 * the on-disk format. A schema version retires entries the current parser
 * could no longer have produced.
 *
 * Retention: an entry expires after `ttlMs` without use, and the store keeps
 * at most `maxEntries` entries, evicting the least recently used first. Both
 * bounds are enforced by a sweep that runs after every save.
 */
import type { ParsedPiSession } from './types';

/** Bumped when the stored shape changes; older entries are discarded. */
export const SESSION_CACHE_SCHEMA = 3;

export interface CachedPiSession {
  /** `sessionCacheKey(host, path)` — the store's keyPath. */
  key: string;
  schema: number;
  /** The host the session was read from; a path alone is not unique across hosts. */
  host: string;
  path: string;
  session: ParsedPiSession;
  /** When this entry was last written from a server read. */
  savedAtMs: number;
  /** When this conversation was last opened; drives the TTL and the LRU order. */
  openedAtMs: number;
}

export interface SessionCacheStorage {
  get(key: string): Promise<CachedPiSession | null>;
  put(entry: CachedPiSession): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<CachedPiSession[]>;
}

export interface SessionCachePolicy {
  /** An entry not opened for this long is dropped. */
  ttlMs: number;
  /** Hard cap on entries; the least recently used past it are dropped. */
  maxEntries: number;
}

export const DEFAULT_SESSION_CACHE_POLICY: SessionCachePolicy = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxEntries: 40,
};

/** Cache key: the host name and the session file path, which together are unique. */
export function sessionCacheKey(host: string | null, path: string): string {
  return `${host ?? ''}\u0000${path}`;
}

export function isExpired(entry: CachedPiSession, nowMs: number, ttlMs: number): boolean {
  return nowMs - entry.openedAtMs > ttlMs;
}

/** Most recently opened first; ties broken by key so the order is total. */
function byOpenedAtDesc(left: CachedPiSession, right: CachedPiSession): number {
  if (left.openedAtMs !== right.openedAtMs) return right.openedAtMs - left.openedAtMs;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * The keys a sweep should delete: every expired entry, then the least recently
 * used entries beyond `maxEntries`. Pure, so the retention policy is tested
 * without a storage.
 */
export function selectEvictionKeys(
  entries: readonly CachedPiSession[],
  nowMs: number,
  policy: SessionCachePolicy,
): string[] {
  const expired = entries.filter((entry) => isExpired(entry, nowMs, policy.ttlMs)).map((entry) => entry.key);
  const live = entries
    .filter((entry) => !isExpired(entry, nowMs, policy.ttlMs))
    .sort(byOpenedAtDesc)
    .slice(Math.max(0, policy.maxEntries))
    .map((entry) => entry.key);
  return [...expired, ...live];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored entry this build can still use: current schema, parseable shape. */
function isUsable(entry: CachedPiSession | null): entry is CachedPiSession {
  return (
    entry !== null &&
    entry.schema === SESSION_CACHE_SCHEMA &&
    isRecord(entry.session) &&
    Array.isArray(entry.session.turns) &&
    typeof entry.key === 'string' &&
    typeof entry.path === 'string'
  );
}

export class SessionBackupCache {
  constructor(
    private readonly storage: SessionCacheStorage,
    private readonly policy: SessionCachePolicy = DEFAULT_SESSION_CACHE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /** The usable backup for `host`/`path`, or null. Never throws: a backup is best-effort. */
  async load(host: string | null, path: string): Promise<CachedPiSession | null> {
    try {
      const entry = await this.storage.get(sessionCacheKey(host, path));
      if (!isUsable(entry)) return null;
      if (isExpired(entry, this.now(), this.policy.ttlMs)) {
        await this.storage.delete(entry.key).catch(() => undefined);
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  /** Remember a fresh server read. A failed write must never fail the open. */
  async save(host: string | null, path: string, session: ParsedPiSession): Promise<void> {
    const nowMs = this.now();
    await this.storage.put({
      key: sessionCacheKey(host, path),
      schema: SESSION_CACHE_SCHEMA,
      host: host ?? '',
      path,
      session,
      savedAtMs: nowMs,
      openedAtMs: nowMs,
    });
    await this.sweep();
  }

  /**
   * Drop one conversation's backup outright: the file it mirrors is gone, and
   * a backup that outlives its session would paint a conversation the host no
   * longer has. Best-effort, like every other write here.
   */
  async forget(host: string | null, path: string): Promise<void> {
    try {
      await this.storage.delete(sessionCacheKey(host, path));
    } catch {
      // A store that cannot be written leaves the entry for the sweep.
    }
  }

  /** Apply the retention policy; safe to call often, cheap when nothing is due. */
  async sweep(): Promise<void> {
    const entries = await this.storage.all();
    for (const key of selectEvictionKeys(entries, this.now(), this.policy)) {
      await this.storage.delete(key);
    }
  }
}

/** In-memory storage: tests, and any environment without IndexedDB. */
export function createMemorySessionCacheStorage(): SessionCacheStorage {
  const entries = new Map<string, CachedPiSession>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(entry) {
      entries.set(entry.key, entry);
    },
    async delete(key) {
      entries.delete(key);
    },
    async all() {
      return [...entries.values()];
    },
  };
}

const CACHE_DATABASE_NAME = 'pocketshell-pi-session-cache-v1';
const CACHE_STORE = 'sessions';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}

/**
 * Durable storage backed by IndexedDB (the app's WebView store on Android),
 * or null where IndexedDB is unavailable — the caller then falls back to
 * memory, and the backup simply lasts as long as the page.
 */
export function createIndexedDbSessionCacheStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): SessionCacheStorage | null {
  if (!factory) return null;
  const open = async (): Promise<IDBDatabase> => {
    const request = factory.open(CACHE_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        database.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    return requestResult(request);
  };
  return {
    async get(key) {
      const database = await open();
      try {
        const transaction = database.transaction(CACHE_STORE, 'readonly');
        const done = transactionDone(transaction);
        const entry = (await requestResult(
          transaction.objectStore(CACHE_STORE).get(key),
        )) as CachedPiSession | undefined;
        await done;
        return entry ?? null;
      } finally {
        database.close();
      }
    },
    async put(entry) {
      const database = await open();
      try {
        const transaction = database.transaction(CACHE_STORE, 'readwrite');
        transaction.objectStore(CACHE_STORE).put(entry);
        await transactionDone(transaction);
      } finally {
        database.close();
      }
    },
    async delete(key) {
      const database = await open();
      try {
        const transaction = database.transaction(CACHE_STORE, 'readwrite');
        transaction.objectStore(CACHE_STORE).delete(key);
        await transactionDone(transaction);
      } finally {
        database.close();
      }
    },
    async all() {
      const database = await open();
      try {
        const transaction = database.transaction(CACHE_STORE, 'readonly');
        const done = transactionDone(transaction);
        const entries = (await requestResult(
          transaction.objectStore(CACHE_STORE).getAll(),
        )) as CachedPiSession[];
        await done;
        return entries;
      } finally {
        database.close();
      }
    },
  };
}

let installedCache: SessionBackupCache | null = null;

/**
 * The process-wide backup cache: IndexedDB where available, memory otherwise.
 * Created lazily so a page that never opens a chat pays nothing.
 */
export function sessionBackupCache(): SessionBackupCache {
  if (installedCache === null) {
    installedCache = new SessionBackupCache(
      createIndexedDbSessionCacheStorage() ?? createMemorySessionCacheStorage(),
    );
  }
  return installedCache;
}

/** Test seam: replace (or, with null, reset) the process-wide cache. */
export function installSessionBackupCache(cache: SessionBackupCache | null): void {
  installedCache = cache;
}
