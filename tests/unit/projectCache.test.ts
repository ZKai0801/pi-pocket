// tests/unit/projectCache.test.ts
/**
 * The project list's local backup (spec §8.5): per-host, bounded, and silent
 * on every failure. These tests pin the three properties the store relies on
 * — a hit is the same list that was saved, a miss is `null` (never an empty
 * list), and one host's backup can never surface under another's name.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROJECTS_CACHE_POLICY,
  PROJECTS_CACHE_SCHEMA,
  PROJECTS_CACHE_STORAGE_KEY,
  ProjectsCache,
  createLocalProjectsCacheStorage,
  createMemoryProjectsCacheStorage,
  isUsableProjectsCacheEntry,
  selectProjectsCacheEvictions,
  type CachedProjects,
} from '../../src/pi/projectCache';

const PROJECTS = [
  { path: '/home/kai/git/pocketshell', name: 'pocketshell' },
  { path: '/home/kai/git/aplexer', name: 'aplexer' },
];

function memoryCache(nowMs = () => 1_000) {
  return new ProjectsCache(createMemoryProjectsCacheStorage(), DEFAULT_PROJECTS_CACHE_POLICY, nowMs);
}

/** A localStorage stand-in: the browser store is one JSON string. */
function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    raw: values,
  };
}

describe('projects cache', () => {
  it('returns the list it saved for that host', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECTS);
    expect(await cache.load('hetzner')).toEqual(PROJECTS);
  });

  it('keys the backup by host, so one host never shows another host\'s list', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECTS);
    expect(await cache.load('other-box')).toBeNull();
    expect(await cache.load(null)).toBeNull();
  });

  it('treats a host-less save as a no-op instead of a shared bucket', async () => {
    const cache = memoryCache();
    await cache.save(null, PROJECTS);
    expect(await cache.load('hetzner')).toBeNull();
  });

  it('misses rather than painting an empty list', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', []);
    expect(await cache.load('hetzner')).toBeNull();
  });

  it('drops an entry the TTL has expired', async () => {
    let now = 1_000;
    const storage = createMemoryProjectsCacheStorage();
    const cache = new ProjectsCache(storage, { ttlMs: 500, maxHosts: 4 }, () => now);
    await cache.save('hetzner', PROJECTS);
    now += 600;
    expect(await cache.load('hetzner')).toBeNull();
    // …and the expired entry is gone, not merely skipped.
    expect(await storage.all()).toEqual([]);
  });

  it('never throws when the storage does', async () => {
    const failing = {
      all: vi.fn(async () => { throw new Error('quota'); }),
      put: vi.fn(async () => { throw new Error('quota'); }),
      delete: vi.fn(async () => { throw new Error('quota'); }),
    };
    const cache = new ProjectsCache(failing);
    await expect(cache.save('hetzner', PROJECTS)).resolves.toBeUndefined();
    await expect(cache.load('hetzner')).resolves.toBeNull();
    await expect(cache.clear('hetzner')).resolves.toBeUndefined();
    await expect(cache.sweep()).resolves.toBeUndefined();
  });

  it('clears one host without touching another', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECTS);
    await cache.save('other-box', PROJECTS);
    await cache.clear('hetzner');
    expect(await cache.load('hetzner')).toBeNull();
    expect(await cache.load('other-box')).toEqual(PROJECTS);
  });

  it('evicts the oldest host past the cap, and every expired one', () => {
    const entries: CachedProjects[] = [
      { host: 'a', schema: PROJECTS_CACHE_SCHEMA, projects: [], savedAtMs: 1 },
      { host: 'b', schema: PROJECTS_CACHE_SCHEMA, projects: [], savedAtMs: 2 },
      { host: 'c', schema: PROJECTS_CACHE_SCHEMA, projects: [], savedAtMs: 3 },
    ];
    expect(selectProjectsCacheEvictions(entries, 10, { ttlMs: 100, maxHosts: 2 }))
      .toEqual(['a']);
    // A ttl that has passed takes everything with it.
    expect(selectProjectsCacheEvictions(entries, 1_000, { ttlMs: 100, maxHosts: 2 }).sort())
      .toEqual(['a', 'b', 'c']);
  });

  it('rejects a stored entry this build cannot read', () => {
    expect(isUsableProjectsCacheEntry({ host: 'a', schema: 999, projects: [], savedAtMs: 1 })).toBe(false);
    expect(isUsableProjectsCacheEntry({ host: 'a', schema: PROJECTS_CACHE_SCHEMA, projects: [{}], savedAtMs: 1 }))
      .toBe(false);
    expect(isUsableProjectsCacheEntry({
      host: 'a',
      schema: PROJECTS_CACHE_SCHEMA,
      projects: PROJECTS,
      savedAtMs: 1,
      name: 'x',
    })).toBe(true);
  });

  it('round-trips through the localStorage record, discarding foreign shapes', async () => {
    const storage = fakeStorage({
      [PROJECTS_CACHE_STORAGE_KEY]: JSON.stringify([
        { host: 'hetzner', schema: PROJECTS_CACHE_SCHEMA, projects: PROJECTS, savedAtMs: 5 },
        { host: 'broken', schema: PROJECTS_CACHE_SCHEMA, projects: 'nope', savedAtMs: 5 },
        { host: 'old', schema: 0, projects: [], savedAtMs: 5 },
      ]),
    });
    const persistent = createLocalProjectsCacheStorage(storage);
    expect(persistent).not.toBeNull();

    const cache = new ProjectsCache(persistent!, DEFAULT_PROJECTS_CACHE_POLICY, () => 10);
    expect(await cache.load('hetzner')).toEqual(PROJECTS);
    expect(await cache.load('broken')).toBeNull();
    expect(await cache.load('old')).toBeNull();

    // A save rewrites the record without duplicating the host's entry.
    await cache.save('hetzner', [{ path: '/home/kai/new', name: 'new' }]);
    const record = JSON.parse(storage.raw.get(PROJECTS_CACHE_STORAGE_KEY) ?? '[]') as CachedProjects[];
    expect(record.filter((entry) => entry.host === 'hetzner')).toHaveLength(1);
    expect(await cache.load('hetzner')).toEqual([{ path: '/home/kai/new', name: 'new' }]);
  });

  it('survives a corrupt record instead of losing the surface', async () => {
    const storage = fakeStorage({ [PROJECTS_CACHE_STORAGE_KEY]: '{not json' });
    const cache = new ProjectsCache(
      createLocalProjectsCacheStorage(storage)!,
      DEFAULT_PROJECTS_CACHE_POLICY,
      () => 10,
    );
    expect(await cache.load('hetzner')).toBeNull();
    await cache.save('hetzner', PROJECTS);
    expect(await cache.load('hetzner')).toEqual(PROJECTS);
  });

  it('degrades to no storage where localStorage is unavailable', () => {
    expect(createLocalProjectsCacheStorage(null)).toBeNull();
  });
});
