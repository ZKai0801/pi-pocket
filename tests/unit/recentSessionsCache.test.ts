// tests/unit/recentSessionsCache.test.ts
/**
 * The 会话 tab's memory of recently opened conversations (spec §8.5): keyed by
 * host, bounded, silent on every failure, and ordered by open time — a reply
 * landing in the background refreshes a row but never reorders the list. These
 * tests pin the properties the store relies on: what a save/load round-trip
 * keeps, what `reopened` means, and the TTL/cap eviction.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECENT_SESSIONS_CACHE_POLICY,
  RECENT_SESSIONS_CACHE_SCHEMA,
  RECENT_SESSIONS_CACHE_STORAGE_KEY,
  RecentSessionsCache,
  createLocalRecentSessionsCacheStorage,
  createMemoryRecentSessionsCacheStorage,
  isUsableRecentSessionEntry,
  selectRecentSessionsCacheEvictions,
  type RecentSessionEntry,
  type RecentSessionMeta,
} from '../../src/pi/recentSessionsCache';

function meta(id: string, over: Partial<RecentSessionMeta> = {}): RecentSessionMeta {
  return {
    path: `/root/${id}.jsonl`,
    id,
    name: `session ${id}`,
    updatedAtMs: 1_700_000_000_000,
    preview: `preview ${id}`,
    turnCount: 2,
    projectPath: '/home/kai/git/pocketshell',
    ...over,
  };
}

function memoryCache(nowMs: () => number = () => 1_000) {
  return new RecentSessionsCache(
    createMemoryRecentSessionsCacheStorage(),
    DEFAULT_RECENT_SESSIONS_CACHE_POLICY,
    nowMs,
  );
}

function ids(entries: RecentSessionEntry[]): string[] {
  return entries.map((entry) => entry.id);
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

describe('recent sessions cache', () => {
  it('returns the conversations it saved for that host, most recently opened first', async () => {
    let now = 1_000;
    const cache = memoryCache(() => now);
    await cache.save('hetzner', meta('a'), false);
    now = 2_000;
    await cache.save('hetzner', meta('b'), false);
    expect(ids(await cache.load('hetzner'))).toEqual(['b', 'a']);
  });

  it('keys the entries by host, so one host never shows another\'s conversations', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', meta('a'), false);
    expect(ids(await cache.load('other-box'))).toEqual([]);
    expect(ids(await cache.load(null))).toEqual([]);
  });

  it('treats a host-less save as a no-op instead of a shared bucket', async () => {
    const cache = memoryCache();
    await cache.save(null, meta('a'), false);
    await cache.save('', meta('a'), false);
    expect(ids(await cache.load('hetzner'))).toEqual([]);
  });

  it('moves a re-opened conversation to the top and keeps a refreshed one in place', async () => {
    let now = 1_000;
    const cache = memoryCache(() => now);
    await cache.save('hetzner', meta('a'), false);
    now = 2_000;
    await cache.save('hetzner', meta('b'), false);
    now = 3_000;
    // A reply landing in a's already-open chat refreshes its row only.
    await cache.save('hetzner', meta('a', { preview: 'newer preview', updatedAtMs: 9 }), false);
    expect(ids(await cache.load('hetzner'))).toEqual(['b', 'a']);
    expect((await cache.load('hetzner')).find((entry) => entry.id === 'a')?.preview)
      .toBe('newer preview');
    now = 4_000;
    // Re-opening it is what jumps it to the top.
    await cache.save('hetzner', meta('a'), true);
    const loaded = await cache.load('hetzner');
    expect(ids(loaded)).toEqual(['a', 'b']);
    expect(loaded[0]?.openedAtMs).toBe(4_000);
  });

  it('drops an entry the TTL has expired', async () => {
    let now = 1_000;
    const storage = createMemoryRecentSessionsCacheStorage();
    const cache = new RecentSessionsCache(storage, { ttlMs: 500, maxEntries: 4 }, () => now);
    await cache.save('hetzner', meta('a'), false);
    now += 600;
    expect(await cache.load('hetzner')).toEqual([]);
    // …and the expired entry is gone, not merely skipped.
    expect(await storage.all()).toEqual([]);
  });

  it('never throws when the storage does', async () => {
    const failing = {
      all: vi.fn(async () => { throw new Error('quota'); }),
      put: vi.fn(async () => { throw new Error('quota'); }),
      delete: vi.fn(async () => { throw new Error('quota'); }),
    };
    const cache = new RecentSessionsCache(failing);
    await expect(cache.save('hetzner', meta('a'), false)).resolves.toBeUndefined();
    await expect(cache.load('hetzner')).resolves.toEqual([]);
    await expect(cache.clearHost('hetzner')).resolves.toBeUndefined();
    await expect(cache.sweep()).resolves.toBeUndefined();
  });

  it('clears every conversation on a host, leaving other hosts alone', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', meta('a'), false);
    await cache.save('hetzner', meta('b'), false);
    await cache.save('other-box', meta('c'), false);
    await cache.clearHost('hetzner');
    expect(await cache.load('hetzner')).toEqual([]);
    expect(ids(await cache.load('other-box'))).toEqual(['c']);
  });

  it('evicts the least recently opened past the cap, and every expired one', () => {
    const entries: RecentSessionEntry[] = [
      { ...meta('1'), host: 'a', schema: RECENT_SESSIONS_CACHE_SCHEMA, openedAtMs: 1 },
      { ...meta('2'), host: 'a', schema: RECENT_SESSIONS_CACHE_SCHEMA, openedAtMs: 2 },
      { ...meta('3'), host: 'b', schema: RECENT_SESSIONS_CACHE_SCHEMA, openedAtMs: 3 },
    ];
    expect(selectRecentSessionsCacheEvictions(entries, 10, { ttlMs: 100, maxEntries: 2 }))
      .toEqual([{ host: 'a', path: '/root/1.jsonl' }]);
    // A ttl that has passed takes everything with it.
    expect(
      selectRecentSessionsCacheEvictions(entries, 1_000, { ttlMs: 100, maxEntries: 2 })
        .map((key) => `${key.host}:${key.path}`)
        .sort(),
    ).toEqual(['a:/root/1.jsonl', 'a:/root/2.jsonl', 'b:/root/3.jsonl']);
  });

  it('caps the rows it returns at the policy maximum', async () => {
    let now = 0;
    const cache = new RecentSessionsCache(
      createMemoryRecentSessionsCacheStorage(),
      { ttlMs: 10_000, maxEntries: 2 },
      () => (now += 1),
    );
    await cache.save('hetzner', meta('a'), false);
    await cache.save('hetzner', meta('b'), false);
    await cache.save('hetzner', meta('c'), false);
    expect(ids(await cache.load('hetzner'))).toEqual(['c', 'b']);
  });

  it('rejects a stored entry this build cannot read', () => {
    const base = {
      ...meta('a'),
      host: 'hetzner',
      schema: RECENT_SESSIONS_CACHE_SCHEMA,
      openedAtMs: 1,
    };
    expect(isUsableRecentSessionEntry({ ...base, schema: 999 })).toBe(false);
    expect(isUsableRecentSessionEntry({ ...base, path: '' })).toBe(false);
    expect(isUsableRecentSessionEntry({ ...base, projectPath: 5 })).toBe(false);
    expect(isUsableRecentSessionEntry({ ...base, openedAtMs: 'soon' })).toBe(false);
    expect(isUsableRecentSessionEntry(base)).toBe(true);
  });

  it('round-trips through the localStorage record, discarding foreign shapes', async () => {
    const storage = fakeStorage({
      [RECENT_SESSIONS_CACHE_STORAGE_KEY]: JSON.stringify([
        { ...meta('a'), host: 'hetzner', schema: RECENT_SESSIONS_CACHE_SCHEMA, openedAtMs: 5 },
        { ...meta('b'), host: 'broken', schema: RECENT_SESSIONS_CACHE_SCHEMA, openedAtMs: 5, preview: 7 },
        { ...meta('c'), host: 'old', schema: 0, openedAtMs: 5 },
      ]),
    });
    const persistent = createLocalRecentSessionsCacheStorage(storage);
    expect(persistent).not.toBeNull();

    const cache = new RecentSessionsCache(persistent!, DEFAULT_RECENT_SESSIONS_CACHE_POLICY, () => 10);
    expect(ids(await cache.load('hetzner'))).toEqual(['a']);
    expect(await cache.load('broken')).toEqual([]);
    expect(await cache.load('old')).toEqual([]);

    // A save rewrites the record without duplicating that conversation's entry.
    await cache.save('hetzner', meta('z'), false);
    const record = JSON.parse(
      storage.raw.get(RECENT_SESSIONS_CACHE_STORAGE_KEY) ?? '[]',
    ) as RecentSessionEntry[];
    expect(record.filter((entry) => entry.host === 'hetzner')).toHaveLength(2);
    expect(ids(await cache.load('hetzner'))).toEqual(['z', 'a']);
  });

  it('survives a corrupt record instead of losing the surface', async () => {
    const storage = fakeStorage({ [RECENT_SESSIONS_CACHE_STORAGE_KEY]: '{not json' });
    const cache = new RecentSessionsCache(
      createLocalRecentSessionsCacheStorage(storage)!,
      DEFAULT_RECENT_SESSIONS_CACHE_POLICY,
      () => 10,
    );
    expect(await cache.load('hetzner')).toEqual([]);
    await cache.save('hetzner', meta('a'), false);
    expect(ids(await cache.load('hetzner'))).toEqual(['a']);
  });

  it('degrades to no storage where localStorage is unavailable', () => {
    expect(createLocalRecentSessionsCacheStorage(null)).toBeNull();
  });
});
