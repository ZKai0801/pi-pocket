/**
 * Local memory of the conversations this phone recently opened — the 会话 tab's
 * first screen (spec §8.5).
 *
 * The 会话 tab used to be dead weight until the 项目 tab had handed it a
 * selection: a cold start showed 先选择一个项目, and getting back into the
 * conversation you were just in meant waiting for project discovery, picking
 * the project, then waiting for its session listing — three chains of SSH round
 * trips to re-open one file. This cache remembers every opened conversation
 * (host, session file, and the row the list shows) so the tab paints them the
 * moment it opens and a tap re-opens the chat directly.
 *
 * The cache is a shortcut, never a source of truth: opening a row still reads
 * the session file from the server, and every fresh read re-saves the entry —
 * the same contract the list backup (`sessionListCache`) follows. Keyed by host
 * — the same file path can exist on several hosts — with a TTL and an entry cap
 * so a phone that talks to many hosts cannot accumulate them forever. Sorting
 * is by open time, not file time: this list answers "what was I just in", so a
 * reply landing in the background must not jump a conversation above the one
 * the user just opened.
 */
import type { PiSessionMeta } from './piRepository';

/** Bumped when the stored shape changes; older entries are discarded. */
export const RECENT_SESSIONS_CACHE_SCHEMA = 1;

/** What a recent row shows, plus where the conversation lives. */
export interface RecentSessionMeta extends PiSessionMeta {
  /** The project directory the conversation belongs to, when the file names one. */
  projectPath: string | null;
}

export interface RecentSessionEntry extends RecentSessionMeta {
  /** The host the conversation was opened on. */
  host: string;
  schema: number;
  /** When this phone last opened it: the list's sort key. */
  openedAtMs: number;
}

/** The identity of one remembered conversation: a file on a host. */
export interface RecentSessionsKey {
  host: string;
  path: string;
}

export interface RecentSessionsCacheStorage {
  all(): Promise<RecentSessionEntry[]>;
  put(entry: RecentSessionEntry): Promise<void>;
  delete(key: RecentSessionsKey): Promise<void>;
}

export interface RecentSessionsCachePolicy {
  /** A conversation not opened for this long is forgotten. */
  ttlMs: number;
  /** Hard cap on remembered conversations; the least recently opened are dropped. */
  maxEntries: number;
}

export const DEFAULT_RECENT_SESSIONS_CACHE_POLICY: RecentSessionsCachePolicy = {
  // Longer than the session list's 14 days: an entry is only ever a shortcut
  // into a file the server still holds, and a conversation opened three weeks
  // ago is exactly the one a returning user looks for first.
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 20,
};

export function isRecentSessionsCacheEntryExpired(
  entry: RecentSessionEntry,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - entry.openedAtMs > ttlMs;
}

/** The entries a sweep should delete: every expired one, then the oldest past `maxEntries`. */
export function selectRecentSessionsCacheEvictions(
  entries: readonly RecentSessionEntry[],
  nowMs: number,
  policy: RecentSessionsCachePolicy,
): RecentSessionsKey[] {
  const expired = entries
    .filter((entry) => isRecentSessionsCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .map((entry) => ({ host: entry.host, path: entry.path }));
  const live = entries
    .filter((entry) => !isRecentSessionsCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .sort((left, right) => right.openedAtMs - left.openedAtMs)
    .slice(Math.max(0, policy.maxEntries))
    .map((entry) => ({ host: entry.host, path: entry.path }));
  return [...expired, ...live];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored entry this build can still use: current schema, parseable shape. */
export function isUsableRecentSessionEntry(value: unknown): value is RecentSessionEntry {
  return (
    isRecord(value) &&
    value.schema === RECENT_SESSIONS_CACHE_SCHEMA &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.id === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    (typeof value.projectPath === 'string' || value.projectPath === null) &&
    typeof value.updatedAtMs === 'number' &&
    Number.isFinite(value.updatedAtMs) &&
    (typeof value.preview === 'string' || value.preview === null) &&
    typeof value.turnCount === 'number' &&
    Number.isFinite(value.turnCount) &&
    typeof value.openedAtMs === 'number' &&
    Number.isFinite(value.openedAtMs)
  );
}

/** Keep only what the row renders: a preview may be long, the shape is fixed. */
function toMeta(meta: RecentSessionMeta): RecentSessionMeta {
  return {
    path: meta.path,
    id: meta.id,
    name: meta.name,
    updatedAtMs: meta.updatedAtMs,
    preview: meta.preview,
    turnCount: meta.turnCount,
    projectPath: meta.projectPath,
  };
}

export class RecentSessionsCache {
  constructor(
    private readonly storage: RecentSessionsCacheStorage,
    private readonly policy: RecentSessionsCachePolicy = DEFAULT_RECENT_SESSIONS_CACHE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The host's remembered conversations, most recently opened first. An empty
   * list is a genuine "nothing recent" here — unlike the list backup, it is not
   * an assertion about a project, so there is nothing to hide behind a miss.
   * Never throws; an unreadable store reads as no recents.
   */
  async load(host: string | null): Promise<RecentSessionEntry[]> {
    // Rows are only meaningful for the host they were opened on: with no host
    // there is nothing to key them by, so stay silent.
    if (host === null || host === '') return [];
    try {
      const entries = (await this.storage.all()).filter(
        (entry) => entry.host === host && isUsableRecentSessionEntry(entry),
      );
      const expired = entries.filter((entry) =>
        isRecentSessionsCacheEntryExpired(entry, this.now(), this.policy.ttlMs),
      );
      for (const entry of expired) {
        await this.storage.delete({ host: entry.host, path: entry.path }).catch(() => undefined);
      }
      const live = entries.filter(
        (entry) => !isRecentSessionsCacheEntryExpired(entry, this.now(), this.policy.ttlMs),
      );
      live.sort((left, right) => right.openedAtMs - left.openedAtMs);
      return live.slice(0, this.policy.maxEntries);
    } catch {
      return [];
    }
  }

  /**
   * Remember an opened conversation. `reopened` tells a fresh open (the entry
   * jumps to the top) from a refresh of a conversation that is already open —
   * a reply landing in the background updates its row but never reorders the
   * list. A failed write must never fail the open that produced it.
   */
  async save(host: string | null, meta: RecentSessionMeta, reopened: boolean): Promise<void> {
    if (host === null || host === '') return;
    try {
      const existing = (await this.storage.all()).find(
        (entry) => entry.host === host && entry.path === meta.path,
      );
      const openedAtMs = reopened || existing === undefined ? this.now() : existing.openedAtMs;
      await this.storage.put({
        host,
        schema: RECENT_SESSIONS_CACHE_SCHEMA,
        ...toMeta(meta),
        openedAtMs,
      });
      await this.sweep();
    } catch {
      // Storage may be full or unavailable; the live chat still stands.
    }
  }

  /**
   * Forget every conversation remembered on one host: its Pi session root was
   * just re-pointed, so every remembered path under the old root is wrong, not
   * merely old — tapping one would open a file that is not there.
   */
  async clearHost(host: string | null): Promise<void> {
    if (host === null || host === '') return;
    try {
      const entries = await this.storage.all();
      for (const entry of entries) {
        if (entry.host === host) {
          await this.storage.delete({ host: entry.host, path: entry.path });
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
      for (const key of selectRecentSessionsCacheEvictions(entries, this.now(), this.policy)) {
        await this.storage.delete(key);
      }
    } catch {
      // A sweep that cannot read the store leaves it as it was.
    }
  }
}

/** In-memory storage: tests, and any environment without localStorage. */
export function createMemoryRecentSessionsCacheStorage(): RecentSessionsCacheStorage {
  const entries = new Map<string, RecentSessionEntry>();

  function idOf(key: RecentSessionsKey): string {
    return `${key.host}\n${key.path}`;
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

/** The single localStorage key holding every host's recents as one record. */
export const RECENT_SESSIONS_CACHE_STORAGE_KEY = 'pocketshell.android.pi.recentSessions.v1';

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
 * preview), so localStorage holds them like the project and list backups.
 * Returns null where localStorage is unavailable; the caller then keeps the
 * cache in memory for the life of the page.
 */
export function createLocalRecentSessionsCacheStorage(
  storage: KeyValueStorage | null = browserStorage(),
): RecentSessionsCacheStorage | null {
  if (!storage) return null;
  // Bound once so the closures below narrow once and keep it.
  const backing: KeyValueStorage = storage;

  function read(): RecentSessionEntry[] {
    let raw: string | null = null;
    try {
      raw = backing.getItem(RECENT_SESSIONS_CACHE_STORAGE_KEY);
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
    return parsed.filter(isUsableRecentSessionEntry);
  }

  function write(entries: readonly RecentSessionEntry[]): void {
    try {
      if (entries.length === 0) backing.removeItem(RECENT_SESSIONS_CACHE_STORAGE_KEY);
      else backing.setItem(RECENT_SESSIONS_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // A full or read-only store degrades to no recents, never to an error.
    }
  }

  function idOf(key: RecentSessionsKey): string {
    return `${key.host}\n${key.path}`;
  }

  return {
    async all() {
      return read();
    },
    async put(entry) {
      const id = idOf(entry);
      write([...read().filter((existing) => idOf(existing) !== id), entry]);
    },
    async delete(key) {
      const id = idOf(key);
      write(read().filter((existing) => idOf(existing) !== id));
    },
  };
}

let installedCache: RecentSessionsCache | null = null;

/** The process-wide recents cache: localStorage where available, memory otherwise. */
export function recentSessionsCache(): RecentSessionsCache {
  if (installedCache === null) {
    installedCache = new RecentSessionsCache(
      createLocalRecentSessionsCacheStorage() ?? createMemoryRecentSessionsCacheStorage(),
    );
  }
  return installedCache;
}

/** Test seam: replace (or, with null, reset) the process-wide cache. */
export function installRecentSessionsCache(cache: RecentSessionsCache | null): void {
  installedCache = cache;
}
