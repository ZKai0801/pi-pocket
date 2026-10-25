/**
 * Durable backup of the `/model` picker's rows: the model list
 * `pi --list-models` answered for a project on a host.
 *
 * The probe is the slowest read in the chat. pi builds its whole session
 * runtime — extensions included, compiled on the fly — before it prints the
 * list, so a cold `/model` waits seconds on the host, and the in-memory answer
 * dies with the chat screen (or the app itself, which Android reclaims
 * nightly). The backup paints the last confirmed rows the moment the picker
 * opens and the live probe replaces them when it lands, so only freshness is
 * ever late, never the rows. The same contract the session list backup
 * (`sessionListCache`) follows.
 *
 * The backup is a cache, never a source of truth: every load still probes the
 * host once per app run (the command-options catalog's job), and the painted
 * rows are only ever shown while that probe is in flight or after it failed.
 * Keyed by host AND project path — two hosts hold different pi installs and
 * credentials, and a project's `.pi/settings.json` narrows its own list. An
 * empty list is a legitimate answer ("no provider has credentials yet", pi
 * exits 0 saying so) and is kept like any other, so a credential-less host
 * does not re-probe on every open either.
 */
import type { PiCommandOption } from './piCommandOptions';

/** Bumped when the stored shape changes; older entries are discarded. */
export const MODEL_LIST_CACHE_SCHEMA = 1;

export interface CachedModelList {
  /** The host the rows were read on. */
  host: string;
  /** The project directory the rows belong to. */
  projectPath: string;
  schema: number;
  models: PiCommandOption[];
  /** When this list was last confirmed by a host probe. */
  savedAtMs: number;
}

/** The identity of one cached list: a project on a host. */
export interface ModelListKey {
  host: string;
  projectPath: string;
}

export interface ModelListCacheStorage {
  all(): Promise<CachedModelList[]>;
  put(entry: CachedModelList): Promise<void>;
  delete(key: ModelListKey): Promise<void>;
}

export interface ModelListCachePolicy {
  /** Lists not confirmed by a host probe for this long are dropped. */
  ttlMs: number;
  /** Hard cap on remembered lists; the least recently confirmed are dropped. */
  maxLists: number;
  /** Rows kept per list, so one host cannot bloat localStorage. */
  maxModels: number;
}

export const DEFAULT_MODEL_LIST_CACHE_POLICY: ModelListCachePolicy = {
  // The background probe re-confirms the list on the first picker open of
  // every app run, so the TTL only bounds how stale a painted list may get
  // when the host stops answering — the session list's 14 days fits that too.
  ttlMs: 14 * 24 * 60 * 60 * 1000,
  maxLists: 8,
  // A row is three short strings; a real catalogue across every credentialed
  // provider stays far below this, so the cap only ever trims the absurd.
  maxModels: 500,
};

function sameKey(left: ModelListKey, right: ModelListKey): boolean {
  return left.host === right.host && left.projectPath === right.projectPath;
}

export function isModelListCacheEntryExpired(
  entry: CachedModelList,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - entry.savedAtMs > ttlMs;
}

/**
 * Expired entries, then the oldest unexpired ones past the cap. Keeping the
 * newest `maxLists` is the whole retention story: a phone that talks to many
 * hosts and projects cannot accumulate backups forever.
 */
export function selectModelListCacheEvictions(
  entries: readonly CachedModelList[],
  nowMs: number,
  policy: ModelListCachePolicy,
): ModelListKey[] {
  const expired = entries.filter((entry) => isModelListCacheEntryExpired(entry, nowMs, policy.ttlMs));
  const kept = entries
    .filter((entry) => !isModelListCacheEntryExpired(entry, nowMs, policy.ttlMs))
    .sort((left, right) => right.savedAtMs - left.savedAtMs)
    .slice(policy.maxLists);
  return [...expired, ...kept].map((entry) => ({ host: entry.host, projectPath: entry.projectPath }));
}

/** One row as `pi --list-models` produced it; a parsed table row is never empty. */
function isUsableModelOption(value: unknown): value is PiCommandOption {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { value?: unknown; label?: unknown; detail?: unknown };
  if (typeof candidate.value !== 'string' || candidate.value === '') return false;
  if (typeof candidate.label !== 'string' || candidate.label === '') return false;
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string') return false;
  return true;
}

export function isUsableModelListCacheEntry(value: unknown): value is CachedModelList {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CachedModelList>;
  return candidate.schema === MODEL_LIST_CACHE_SCHEMA
    && typeof candidate.host === 'string' && candidate.host !== ''
    && typeof candidate.projectPath === 'string' && candidate.projectPath !== ''
    && Array.isArray(candidate.models) && candidate.models.every(isUsableModelOption)
    && typeof candidate.savedAtMs === 'number' && Number.isFinite(candidate.savedAtMs);
}

export class ModelListsCache {
  constructor(
    private readonly storage: ModelListCacheStorage,
    private readonly policy: ModelListCachePolicy = DEFAULT_MODEL_LIST_CACHE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The backup rows for one project on one host, or null. Never throws. An
   * empty array is a hit, not a miss: "no provider has credentials" is a real
   * host answer and painting it spares the probe, unlike the session list
   * where an empty paint would claim a project has no conversations.
   */
  async load(host: string | null, projectPath: string | null): Promise<PiCommandOption[] | null> {
    // Rows are only meaningful for the host and project they were read in:
    // with either missing there is nothing to key them by, so stay silent.
    if (host === null || host === '' || projectPath === null || projectPath === '') return null;
    try {
      const entry = (await this.storage.all()).find((candidate) => sameKey(candidate, { host, projectPath }));
      if (entry === undefined || !isUsableModelListCacheEntry(entry)) return null;
      if (isModelListCacheEntryExpired(entry, this.now(), this.policy.ttlMs)) {
        await this.storage.delete({ host, projectPath }).catch(() => undefined);
        return null;
      }
      return entry.models.slice(0, this.policy.maxModels);
    } catch {
      return null;
    }
  }

  /** Remember a fresh host answer. A failed write must never fail the load. */
  async save(
    host: string | null,
    projectPath: string | null,
    models: readonly PiCommandOption[],
  ): Promise<void> {
    if (host === null || host === '' || projectPath === null || projectPath === '') return;
    try {
      await this.storage.put({
        host,
        projectPath,
        schema: MODEL_LIST_CACHE_SCHEMA,
        models: models.slice(0, this.policy.maxModels),
        savedAtMs: this.now(),
      });
      await this.sweep();
    } catch {
      // Storage may be full or unavailable; the live list still stands.
    }
  }

  /** Apply the retention policy; safe to call often, cheap when nothing is due. */
  async sweep(): Promise<void> {
    try {
      const entries = await this.storage.all();
      for (const key of selectModelListCacheEvictions(entries, this.now(), this.policy)) {
        await this.storage.delete(key);
      }
    } catch {
      // A sweep that cannot read the store leaves it as it was.
    }
  }
}

/** In-memory storage: tests, and any environment without localStorage. */
export function createMemoryModelListCacheStorage(): ModelListCacheStorage {
  const entries = new Map<string, CachedModelList>();

  function idOf(key: ModelListKey): string {
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

/** The single localStorage key holding every host's model lists as one record. */
export const MODEL_LISTS_CACHE_STORAGE_KEY = 'pocketshell.android.pi.modelListsCache.v1';

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
 * The phone's durable storage: rows are tiny (a token, a label, a provider),
 * so localStorage holds them like the session list — the model list never
 * grows a transcript's worth of bytes. Returns null where localStorage is
 * unavailable; the caller then keeps the cache in memory for the page's life.
 */
export function createLocalModelListCacheStorage(
  storage: KeyValueStorage | null = browserStorage(),
): ModelListCacheStorage | null {
  if (!storage) return null;
  // Bound once so the closures below narrow once and keep it.
  const backing: KeyValueStorage = storage;

  function read(): CachedModelList[] {
    let raw: string | null = null;
    try {
      raw = backing.getItem(MODEL_LISTS_CACHE_STORAGE_KEY);
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
    return parsed.filter(isUsableModelListCacheEntry);
  }

  function write(entries: readonly CachedModelList[]): void {
    try {
      if (entries.length === 0) backing.removeItem(MODEL_LISTS_CACHE_STORAGE_KEY);
      else backing.setItem(MODEL_LISTS_CACHE_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // A full or read-only store degrades to no backup, never to an error.
    }
  }

  function idOf(key: ModelListKey): string {
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

let installedCache: ModelListsCache | null = null;

/** The process-wide backup cache: localStorage where available, memory otherwise. */
export function modelListsCache(): ModelListsCache {
  if (installedCache === null) {
    installedCache = new ModelListsCache(
      createLocalModelListCacheStorage() ?? createMemoryModelListCacheStorage(),
    );
  }
  return installedCache;
}

/** Test seam: replace (or, with null, reset) the process-wide cache. */
export function installModelListsCache(cache: ModelListsCache | null): void {
  installedCache = cache;
}
