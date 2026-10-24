import { describe, expect, it, vi } from 'vitest';
import type { ParsedPiSession } from '../../src/pi/types';
import {
  DEFAULT_SESSION_CACHE_POLICY,
  SESSION_CACHE_SCHEMA,
  SessionBackupCache,
  createMemorySessionCacheStorage,
  isExpired,
  selectEvictionKeys,
  sessionCacheKey,
  type CachedPiSession,
} from '../../src/pi/sessionCache';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function session(id: string): ParsedPiSession {
  return { version: 3, id, cwd: '/home/kai', name: null, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] };
}

function entry(
  key: string,
  openedAtMs: number,
  overrides: Partial<CachedPiSession> = {},
): CachedPiSession {
  const [host, path] = key.split('\u0000');
  return {
    key,
    schema: SESSION_CACHE_SCHEMA,
    host: host ?? '',
    path: path ?? '',
    session: session(key),
    savedAtMs: openedAtMs,
    openedAtMs,
    ...overrides,
  };
}

describe('session cache key', () => {
  it('scopes a session path to its host', () => {
    expect(sessionCacheKey('alexey', '/r/a.jsonl')).toBe('alexey\u0000/r/a.jsonl');
    expect(sessionCacheKey('other', '/r/a.jsonl')).not.toBe(sessionCacheKey('alexey', '/r/a.jsonl'));
  });

  it('treats a host-less call as its own scope', () => {
    expect(sessionCacheKey(null, '/r/a.jsonl')).toBe('\u0000/r/a.jsonl');
  });
});

describe('session cache retention', () => {
  const policy = { ttlMs: 7 * DAY_MS, maxEntries: 2 };

  it('expires an entry not opened within the ttl', () => {
    const now = 100 * DAY_MS;
    expect(isExpired(entry('h\u0000a', now - 8 * DAY_MS), now, policy.ttlMs)).toBe(true);
    expect(isExpired(entry('h\u0000a', now - 6 * DAY_MS), now, policy.ttlMs)).toBe(false);
  });

  it('selects expired entries and the least recently used beyond the cap', () => {
    const now = 100 * DAY_MS;
    const entries = [
      entry('h\u0000old', now - 30 * DAY_MS), // expired
      entry('h\u0000lru', now - 3 * DAY_MS), // live, oldest
      entry('h\u0000recent', now - 1 * DAY_MS), // live, newest
      entry('h\u0000fresh', now - 2 * HOUR_MS), // live, newest of all
    ];
    expect(selectEvictionKeys(entries, now, policy)).toEqual(['h\u0000old', 'h\u0000lru']);
  });

  it('breaks openedAt ties by key so the sweep is deterministic', () => {
    const now = 100 * DAY_MS;
    const entries = [entry('h\u0000b', now), entry('h\u0000a', now)];
    // A cap of one forces the tie to be broken; the key order decides it.
    expect(selectEvictionKeys(entries, now, { ttlMs: 7 * DAY_MS, maxEntries: 1 })).toEqual(['h\u0000b']);
  });

  it('keeps everything within the cap', () => {
    const now = 100 * DAY_MS;
    expect(selectEvictionKeys([entry('h\u0000a', now), entry('h\u0000b', now - DAY_MS)], now, policy)).toEqual([]);
  });

  it('uses a seven-day ttl and a 40-entry cap by default', () => {
    expect(DEFAULT_SESSION_CACHE_POLICY.ttlMs).toBe(7 * DAY_MS);
    expect(DEFAULT_SESSION_CACHE_POLICY.maxEntries).toBe(40);
  });
});

describe('SessionBackupCache', () => {
  it('round-trips a saved parse through storage', async () => {
    const storage = createMemorySessionCacheStorage();
    const cache = new SessionBackupCache(storage);
    await cache.save('alexey', '/r/a.jsonl', session('a'));
    const loaded = await cache.load('alexey', '/r/a.jsonl');
    expect(loaded?.session).toEqual(session('a'));
    expect(loaded?.host).toBe('alexey');
    expect(loaded?.path).toBe('/r/a.jsonl');
    // A miss on another host's identical path: the key is host-scoped.
    expect(await cache.load('other', '/r/a.jsonl')).toBeNull();
  });

  it('returns null for an unknown key', async () => {
    expect(await new SessionBackupCache(createMemorySessionCacheStorage()).load('h', '/nope.jsonl')).toBeNull();
  });

  it('returns null and deletes an entry past the ttl', async () => {
    const storage = createMemorySessionCacheStorage();
    let now = 100 * DAY_MS;
    const cache = new SessionBackupCache(storage, DEFAULT_SESSION_CACHE_POLICY, () => now);
    await cache.save('h', '/a.jsonl', session('a'));
    now += 8 * DAY_MS;
    expect(await cache.load('h', '/a.jsonl')).toBeNull();
    expect(await storage.all()).toHaveLength(0);
  });

  it('rejects an entry a newer schema could not have produced', async () => {
    const storage = createMemorySessionCacheStorage();
    const key = sessionCacheKey('h', '/a.jsonl');
    await storage.put({ ...entry(key, 100 * DAY_MS), schema: SESSION_CACHE_SCHEMA - 1 });
    expect(await new SessionBackupCache(storage).load('h', '/a.jsonl')).toBeNull();
  });

  it('rejects a structurally broken entry instead of trusting it', async () => {
    const storage = createMemorySessionCacheStorage();
    const key = sessionCacheKey('h', '/a.jsonl');
    await storage.put({ ...entry(key, 100 * DAY_MS), session: { version: 3 } as never });
    expect(await new SessionBackupCache(storage).load('h', '/a.jsonl')).toBeNull();
  });

  it('never throws when storage fails: a miss reads as no backup', async () => {
    const storage = createMemorySessionCacheStorage();
    const cache = new SessionBackupCache({
      get: vi.fn(async () => { throw new Error('idb blocked'); }),
      put: storage.put,
      delete: storage.delete,
      all: storage.all,
    });
    expect(await cache.load('h', '/a.jsonl')).toBeNull();
  });

  it('forgets one conversation without disturbing the others', async () => {
    const storage = createMemorySessionCacheStorage();
    const cache = new SessionBackupCache(storage);
    await cache.save('hetzner', '/a.jsonl', session('a'));
    await cache.save('hetzner', '/b.jsonl', session('b'));
    await cache.forget('hetzner', '/a.jsonl');

    expect(await cache.load('hetzner', '/a.jsonl')).toBeNull();
    expect(await cache.load('hetzner', '/b.jsonl')).not.toBeNull();
  });

  it('forgets a conversation only on the host it was forgotten on', async () => {
    const storage = createMemorySessionCacheStorage();
    const cache = new SessionBackupCache(storage);
    await cache.save('hetzner', '/a.jsonl', session('a'));
    await cache.save('other-box', '/a.jsonl', session('a'));
    await cache.forget('hetzner', '/a.jsonl');

    expect(await cache.load('hetzner', '/a.jsonl')).toBeNull();
    expect(await cache.load('other-box', '/a.jsonl')).not.toBeNull();
  });

  it('never throws when the storage cannot forget', async () => {
    const storage = createMemorySessionCacheStorage();
    const cache = new SessionBackupCache({
      get: storage.get,
      put: storage.put,
      delete: vi.fn(async () => { throw new Error('idb blocked'); }),
      all: storage.all,
    });
    await expect(cache.forget('hetzner', '/a.jsonl')).resolves.toBeUndefined();
  });

  it('sweeps the least recently used entries past the cap on every save', async () => {
    const storage = createMemorySessionCacheStorage();
    let now = 100 * DAY_MS;
    const cache = new SessionBackupCache(storage, { ttlMs: 7 * DAY_MS, maxEntries: 2 }, () => now);
    await cache.save('h', '/a.jsonl', session('a'));
    now += HOUR_MS;
    await cache.save('h', '/b.jsonl', session('b'));
    now += HOUR_MS;
    await cache.save('h', '/c.jsonl', session('c'));
    const keys = (await storage.all()).map((stored) => stored.path).sort();
    expect(keys).toEqual(['/b.jsonl', '/c.jsonl']);
  });

  it('sweeps expired entries even when the cap is not reached', async () => {
    const storage = createMemorySessionCacheStorage();
    let now = 100 * DAY_MS;
    const cache = new SessionBackupCache(storage, DEFAULT_SESSION_CACHE_POLICY, () => now);
    await cache.save('h', '/a.jsonl', session('a'));
    now += 8 * DAY_MS;
    await cache.save('h', '/b.jsonl', session('b'));
    const keys = (await storage.all()).map((stored) => stored.path);
    expect(keys).toEqual(['/b.jsonl']);
  });
});
