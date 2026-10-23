/**
 * Local backup of a host's Pi project list. Discovery walks the session root
 * and reads one header line per project directory — on a phone that is a
 * chain of SSH round trips, so a cold start used to stare at 正在发现项目… for
 * seconds. The backup paints the last known list immediately on reconnect and
 * the server's fresh listing replaces it when it lands, so a new project
 * appears seconds late instead of the list appearing seconds late (spec §8.5).
 *
 * The backup is a cache, never a source of truth: every discovery re-lists the
 * server, and the paint is only ever shown while that listing is in flight or
 * after it failed. Keyed by host — two hosts may hold different session roots
 * — and bounded by a TTL and a host cap so a phone that talks to many hosts
 * cannot accumulate them forever.
 */
import type { PiProject } from './piRepository';

/** Bumped when the stored shape changes; older entries are discarded. */
export const PROJECTS_CACHE_SCHEMA = 1;

export interface CachedProjects {
  /** The saved host name the list was discovered on. */
  host: string;
  schema: number;
  projects: PiProject[];
  /** When this list was last confirmed by a server listing. */
  savedAtMs: number;
}

export interface ProjectsCacheStorage {
  all(): Promise<CachedProjects[]>;
  put(entry: CachedProjects): Promise<void>;
  delete(host: string): Promise<void>;
}

export interface ProjectsCachePolicy {
  /** A list not confirmed by the server for this long is dropped. */
  ttlMs: number;
  /** Hard cap on remembered hosts; the least recently confirmed are dropped. */
  maxHosts: number;
}

export const DEFAULT_PROJECTS_CACHE_POLICY: ProjectsCachePolicy = {
  // Projects change rarely (a clone, a new agent run), and a stale list is
  // only ever a placeholder for the listing that follows it — so the backup
  // may live long, while still expiring on a host nobody connects to.
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxHosts: 8,
};

export function isProjectsCacheEntryExpired(
  entry: CachedProjects,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - entry.savedAtMs > ttlMs;
}

/** The hosts a sweep should delete: every expired entry, then the oldest past `maxHosts`. */
export function selectProjectsCacheEvictions(
  entries: readonly CachedProjects[],
  nowMs: number,
  policy: ProjectsCachePolicy,
): string[] {
  const expired = entries
    .filter((entry) => isProjectsCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .map((entry) => entry.host);
  const live = entries
    .filter((entry) => !isProjectsCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .sort((left, right) => right.savedAtMs - left.savedAtMs)
    .slice(Math.max(0, policy.maxHosts))
    .map((entry) => entry.host);
  return [...expired, ...live];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProject(value: unknown): value is PiProject {
  return isRecord(value) && typeof value.path === 'string' && typeof value.name === 'string';
}

/** A stored entry this build can still use: current schema, parseable shape. */
export function isUsableProjectsCacheEntry(value: unknown): value is CachedProjects {
  return (
    isRecord(value) &&
    value.schema === PROJECTS_CACHE_SCHEMA &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    typeof value.savedAtMs === 'number' &&
    Number.isFinite(value.savedAtMs) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProject)
  );
}

export class ProjectsCache {
  constructor(
    private readonly storage: ProjectsCacheStorage,
    private readonly policy: ProjectsCachePolicy = DEFAULT_PROJECTS_CACHE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The backup for `host`, or null. Never throws and never returns an empty
   * list as a hit: an empty discovery is not worth painting over.
   */
  async load(host: string | null): Promise<PiProject[] | null> {
    // A list is only meaningful for the host it was read on: with no host
    // there is nothing to key it by, so the cache stays silent.
    if (host === null || host === '') return null;
    try {
      const entry = (await this.storage.all()).find((candidate) => candidate.host === host);
      if (entry === undefined || !isUsableProjectsCacheEntry(entry)) return null;
      if (isProjectsCacheEntryExpired(entry, this.now(), this.policy.ttlMs)) {
        await this.storage.delete(host).catch(() => undefined);
        return null;
      }
      if (entry.projects.length === 0) return null;
      return entry.projects.map((project) => ({ path: project.path, name: project.name }));
    } catch {
      return null;
    }
  }

  /** Remember a fresh server listing. A failed write must never fail discovery. */
  async save(host: string | null, projects: readonly PiProject[]): Promise<void> {
    if (host === null || host === '') return;
    try {
      await this.storage.put({
        host,
        schema: PROJECTS_CACHE_SCHEMA,
        projects: projects.map((project) => ({ path: project.path, name: project.name })),
        savedAtMs: this.now(),
      });
      await this.sweep();
    } catch {
      // Storage may be full or unavailable; the live list still stands.
    }
  }

  /** Forget a host's backup (its session root was just changed, so it is wrong). */
  async clear(host: string | null): Promise<void> {
    if (host === null || host === '') return;
    await this.storage.delete(host).catch(() => undefined);
  }

  /** Apply the retention policy; safe to call often, cheap when nothing is due. */
  async sweep(): Promise<void> {
    try {
      const entries = await this.storage.all();
      for (const host of selectProjectsCacheEvictions(entries, this.now(), this.policy)) {
        await this.storage.delete(host);
      }
    } catch {
      // A sweep that cannot read the store leaves it as it was.
    }
  }
}

/** In-memory storage: tests, and any environment without localStorage. */
export function createMemoryProjectsCacheStorage(): ProjectsCacheStorage {
  const entries = new Map<string, CachedProjects>();
  return {
    async all() {
      return [...entries.values()];
    },
    async put(entry) {
      entries.set(entry.host, entry);
    },
    async delete(host) {
      entries.delete(host);
    },
  };
}

/** The single localStorage key holding every host's entry as one record. */
export const PROJECTS_CACHE_STORAGE_KEY = 'pocketshell.android.pi.projectsCache.v1';

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
 * The phone's durable storage: one small JSON record (tens of paths), so
 * localStorage is the right store here — the session backup needs IndexedDB
 * only because a parsed conversation is orders of magnitude larger. Returns
 * null where localStorage is unavailable; the caller then keeps the cache in
 * memory for the life of the page.
 */
export function createLocalProjectsCacheStorage(
  storage: KeyValueStorage | null = browserStorage(),
): ProjectsCacheStorage | null {
  if (!storage) return null;
  // Bound once so the closures below narrow once and keep it.
  const backing: KeyValueStorage = storage;

  function read(): CachedProjects[] {
    let raw: string | null = null;
    try {
      raw = backing.getItem(PROJECTS_CACHE_STORAGE_KEY);
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
    return parsed.filter(isUsableProjectsCacheEntry);
  }

  function write(entries: readonly CachedProjects[]): void {
    try {
      if (entries.length === 0) backing.removeItem(PROJECTS_CACHE_STORAGE_KEY);
      else backing.setItem(PROJECTS_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // A full or read-only store degrades to no backup, never to an error.
    }
  }

  return {
    async all() {
      return read();
    },
    async put(entry) {
      const entries = read().filter((existing) => existing.host !== entry.host);
      write([...entries, entry]);
    },
    async delete(host) {
      write(read().filter((existing) => existing.host !== host));
    },
  };
}

let installedCache: ProjectsCache | null = null;

/** The process-wide backup cache: localStorage where available, memory otherwise. */
export function projectsListCache(): ProjectsCache {
  if (installedCache === null) {
    installedCache = new ProjectsCache(
      createLocalProjectsCacheStorage() ?? createMemoryProjectsCacheStorage(),
    );
  }
  return installedCache;
}

/** Test seam: replace (or, with null, reset) the process-wide cache. */
export function installProjectsListCache(cache: ProjectsCache | null): void {
  installedCache = cache;
}
