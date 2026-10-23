// tests/unit/sessionListCache.test.ts
/**
 * The 会话 tab's local backup (spec §8.5): per host AND per project, bounded,
 * and silent on every failure. These tests pin the properties the store relies
 * on — a hit is the rows that were saved, a miss is `null` (never an empty
 * list masquerading as "this project has no conversations"), and one project's
 * rows can never surface under another project's name on the same host.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PiSessionMeta } from '../../src/pi/piRepository';
import {
  DEFAULT_SESSION_LIST_CACHE_POLICY,
  SESSION_LIST_CACHE_SCHEMA,
  SESSION_LISTS_CACHE_STORAGE_KEY,
  SessionListsCache,
  createLocalSessionListCacheStorage,
  createMemorySessionListCacheStorage,
  isUsableSessionListCacheEntry,
  selectSessionListCacheEvictions,
  type CachedSessionList,
} from '../../src/pi/sessionListCache';

const PROJECT = '/home/kai/git/pocketshell';

function row(id: string, over: Partial<PiSessionMeta> = {}): PiSessionMeta {
  return {
    path: `/root/-home-kai-git-pocketshell/${id}.jsonl`,
    id,
    name: `session ${id}`,
    updatedAtMs: 1_700_000_000_000,
    preview: `preview ${id}`,
    turnCount: 2,
    ...over,
  };
}

const ROWS = [row('b'), row('a')];

function memoryCache(nowMs = () => 1_000) {
  return new SessionListsCache(
    createMemorySessionListCacheStorage(),
    DEFAULT_SESSION_LIST_CACHE_POLICY,
    nowMs,
  );
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

describe('session list cache', () => {
  it('returns the rows it saved for that host and project', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, ROWS);
    expect(await cache.load('hetzner', PROJECT)).toEqual(ROWS);
  });

  it('keys the backup by project, so one project never shows another\'s rows', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, ROWS);
    expect(await cache.load('hetzner', '/home/kai/git/aplexer')).toBeNull();
  });

  it('keys the backup by host, so one host never shows another\'s rows', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, ROWS);
    expect(await cache.load('other-box', PROJECT)).toBeNull();
    expect(await cache.load(null, PROJECT)).toBeNull();
  });

  it('treats a host-less or project-less save as a no-op instead of a shared bucket', async () => {
    const cache = memoryCache();
    await cache.save(null, PROJECT, ROWS);
    await cache.save('hetzner', null, ROWS);
    await cache.save('hetzner', '', ROWS);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('misses rather than painting an empty list', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, []);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('drops an entry the TTL has expired', async () => {
    let now = 1_000;
    const storage = createMemorySessionListCacheStorage();
    const cache = new SessionListsCache(storage, { ttlMs: 500, maxLists: 4, maxSessions: 50 }, () => now);
    await cache.save('hetzner', PROJECT, ROWS);
    now += 600;
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    // …and the expired entry is gone, not merely skipped.
    expect(await storage.all()).toEqual([]);
  });

  it('never throws when the storage does', async () => {
    const failing = {
      all: vi.fn(async () => { throw new Error('quota'); }),
      put: vi.fn(async () => { throw new Error('quota'); }),
      delete: vi.fn(async () => { throw new Error('quota'); }),
    };
    const cache = new SessionListsCache(failing);
    await expect(cache.save('hetzner', PROJECT, ROWS)).resolves.toBeUndefined();
    await expect(cache.load('hetzner', PROJECT)).resolves.toBeNull();
    await expect(cache.clear('hetzner', PROJECT)).resolves.toBeUndefined();
    await expect(cache.clearHost('hetzner')).resolves.toBeUndefined();
    await expect(cache.sweep()).resolves.toBeUndefined();
  });

  it('clears one project without touching another on the same host', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, ROWS);
    await cache.save('hetzner', '/home/kai/git/aplexer', [row('c')]);
    await cache.clear('hetzner', PROJECT);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    expect(await cache.load('hetzner', '/home/kai/git/aplexer')).toEqual([row('c')]);
  });

  it('clears every project on a host, leaving other hosts alone', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, ROWS);
    await cache.save('hetzner', '/home/kai/git/aplexer', [row('c')]);
    await cache.save('other-box', PROJECT, ROWS);
    await cache.clearHost('hetzner');
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    expect(await cache.load('hetzner', '/home/kai/git/aplexer')).toBeNull();
    expect(await cache.load('other-box', PROJECT)).toEqual(ROWS);
  });

  it('truncates a very long project instead of letting it bloat the store', async () => {
    const storage = createMemorySessionListCacheStorage();
    const cache = new SessionListsCache(storage, { ttlMs: 1_000, maxLists: 4, maxSessions: 2 }, () => 10);
    await cache.save('hetzner', PROJECT, [row('1'), row('2'), row('3')]);
    expect((await cache.load('hetzner', PROJECT))?.map((session) => session.id)).toEqual(['1', '2']);
    expect((await storage.all())[0]?.sessions).toHaveLength(2);
  });

  it('evicts the oldest list past the cap, and every expired one', () => {
    const entries: CachedSessionList[] = [
      { host: 'a', projectPath: '/p/1', schema: SESSION_LIST_CACHE_SCHEMA, sessions: [], savedAtMs: 1 },
      { host: 'a', projectPath: '/p/2', schema: SESSION_LIST_CACHE_SCHEMA, sessions: [], savedAtMs: 2 },
      { host: 'b', projectPath: '/p/1', schema: SESSION_LIST_CACHE_SCHEMA, sessions: [], savedAtMs: 3 },
    ];
    expect(selectSessionListCacheEvictions(entries, 10, { ttlMs: 100, maxLists: 2, maxSessions: 5 }))
      .toEqual([{ host: 'a', projectPath: '/p/1' }]);
    // A ttl that has passed takes everything with it.
    expect(
      selectSessionListCacheEvictions(entries, 1_000, { ttlMs: 100, maxLists: 2, maxSessions: 5 })
        .map((key) => `${key.host}:${key.projectPath}`)
        .sort(),
    ).toEqual(['a:/p/1', 'a:/p/2', 'b:/p/1']);
  });

  it('rejects a stored entry this build cannot read', () => {
    const base = {
      host: 'hetzner',
      projectPath: PROJECT,
      schema: SESSION_LIST_CACHE_SCHEMA,
      sessions: ROWS,
      savedAtMs: 1,
    };
    expect(isUsableSessionListCacheEntry({ ...base, schema: 999 })).toBe(false);
    expect(isUsableSessionListCacheEntry({ ...base, sessions: [{ path: '/x' }] })).toBe(false);
    expect(isUsableSessionListCacheEntry({ ...base, sessions: [{}] })).toBe(false);
    expect(isUsableSessionListCacheEntry(base)).toBe(true);
  });

  it('round-trips through the localStorage record, discarding foreign shapes', async () => {
    const storage = fakeStorage({
      [SESSION_LISTS_CACHE_STORAGE_KEY]: JSON.stringify([
        { host: 'hetzner', projectPath: PROJECT, schema: SESSION_LIST_CACHE_SCHEMA, sessions: ROWS, savedAtMs: 5 },
        { host: 'broken', projectPath: PROJECT, schema: SESSION_LIST_CACHE_SCHEMA, sessions: 'nope', savedAtMs: 5 },
        { host: 'old', projectPath: PROJECT, schema: 0, sessions: [], savedAtMs: 5 },
      ]),
    });
    const persistent = createLocalSessionListCacheStorage(storage);
    expect(persistent).not.toBeNull();

    const cache = new SessionListsCache(persistent!, DEFAULT_SESSION_LIST_CACHE_POLICY, () => 10);
    expect(await cache.load('hetzner', PROJECT)).toEqual(ROWS);
    expect(await cache.load('broken', PROJECT)).toBeNull();
    expect(await cache.load('old', PROJECT)).toBeNull();

    // A save rewrites the record without duplicating that list's entry.
    await cache.save('hetzner', PROJECT, [row('z')]);
    const record = JSON.parse(storage.raw.get(SESSION_LISTS_CACHE_STORAGE_KEY) ?? '[]') as CachedSessionList[];
    expect(record.filter((entry) => entry.host === 'hetzner' && entry.projectPath === PROJECT))
      .toHaveLength(1);
    expect(await cache.load('hetzner', PROJECT)).toEqual([row('z')]);
  });

  it('survives a corrupt record instead of losing the surface', async () => {
    const storage = fakeStorage({ [SESSION_LISTS_CACHE_STORAGE_KEY]: '{not json' });
    const cache = new SessionListsCache(
      createLocalSessionListCacheStorage(storage)!,
      DEFAULT_SESSION_LIST_CACHE_POLICY,
      () => 10,
    );
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    await cache.save('hetzner', PROJECT, ROWS);
    expect(await cache.load('hetzner', PROJECT)).toEqual(ROWS);
  });

  it('degrades to no storage where localStorage is unavailable', () => {
    expect(createLocalSessionListCacheStorage(null)).toBeNull();
  });
});
