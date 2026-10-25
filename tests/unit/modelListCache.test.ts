// tests/unit/modelListCache.test.ts
/**
 * The /model picker's local backup: per host AND per project, bounded, and
 * silent on every failure. These tests pin the properties the picker relies
 * on — a hit is the rows that were saved (an EMPTY list included, because "no
 * provider has credentials" is a real host answer worth sparing the probe),
 * a miss is `null`, and one host+project's rows can never surface under
 * another's name.
 */
import { describe, expect, it } from 'vitest';
import type { PiCommandOption } from '../../src/pi/piCommandOptions';
import {
  DEFAULT_MODEL_LIST_CACHE_POLICY,
  MODEL_LIST_CACHE_SCHEMA,
  MODEL_LISTS_CACHE_STORAGE_KEY,
  ModelListsCache,
  createLocalModelListCacheStorage,
  createMemoryModelListCacheStorage,
  isUsableModelListCacheEntry,
  selectModelListCacheEvictions,
} from '../../src/pi/modelListCache';

const PROJECT = '/home/kai/git/pocketshell';

function model(value: string): PiCommandOption {
  return { value, label: value, detail: value.split('/')[0] ?? value };
}

const MODELS: PiCommandOption[] = [model('anthropic/claude-sonnet-4'), model('openai/gpt-5')];

function memoryCache(nowMs = () => 1_000) {
  return new ModelListsCache(
    createMemoryModelListCacheStorage(),
    DEFAULT_MODEL_LIST_CACHE_POLICY,
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

describe('model list cache', () => {
  it('returns the rows it saved for that host and project', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('hetzner', PROJECT)).toEqual(MODELS);
  });

  it("keys the backup by project, so one project never shows another's rows", async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('hetzner', '/home/kai/git/aplexer')).toBeNull();
  });

  it("keys the backup by host, so one host never shows another's rows", async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('laptop', PROJECT)).toBeNull();
  });

  it('keeps an empty list: no credentials is an answer, not a miss', async () => {
    const cache = memoryCache();
    await cache.save('hetzner', PROJECT, []);
    expect(await cache.load('hetzner', PROJECT)).toEqual([]);
  });

  it('treats a host-less or project-less save as a no-op instead of a shared bucket', async () => {
    const cache = memoryCache();
    await cache.save(null, PROJECT, MODELS);
    await cache.save('hetzner', null, MODELS);
    await cache.save('', PROJECT, MODELS);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    expect(await cache.load(null, PROJECT)).toBeNull();
  });

  it('drops an entry the TTL has expired', async () => {
    let now = 1_000;
    const cache = memoryCache(() => now);
    await cache.save('hetzner', PROJECT, MODELS);

    now += DEFAULT_MODEL_LIST_CACHE_POLICY.ttlMs;
    expect(await cache.load('hetzner', PROJECT)).toEqual(MODELS);
    now += 1;
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('never throws when the storage does', async () => {
    const cache = new ModelListsCache(
      {
        all: () => Promise.reject(new Error('full')),
        put: () => Promise.reject(new Error('full')),
        delete: () => Promise.reject(new Error('full')),
      },
      DEFAULT_MODEL_LIST_CACHE_POLICY,
    );
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('sweeps the least recently confirmed entries past the cap on every save', async () => {
    let now = 1_000;
    const cache = new ModelListsCache(
      createMemoryModelListCacheStorage(),
      { ...DEFAULT_MODEL_LIST_CACHE_POLICY, maxLists: 2 },
      () => now,
    );
    await cache.save('hetzner', '/p1', MODELS);
    now += 1;
    await cache.save('hetzner', '/p2', MODELS);
    now += 1;
    await cache.save('hetzner', '/p3', MODELS);

    expect(await cache.load('hetzner', '/p1')).toBeNull();
    expect(await cache.load('hetzner', '/p2')).toEqual(MODELS);
    expect(await cache.load('hetzner', '/p3')).toEqual(MODELS);
  });

  it('sweeps expired entries even when the cap is not reached', async () => {
    let now = 1_000;
    const cache = memoryCache(() => now);
    await cache.save('hetzner', PROJECT, MODELS);
    now += DEFAULT_MODEL_LIST_CACHE_POLICY.ttlMs + 1;
    await cache.save('hetzner', '/p2', MODELS);

    expect(await cache.load('hetzner', PROJECT)).toBeNull();
    expect(await cache.load('hetzner', '/p2')).toEqual(MODELS);
  });

  it('truncates a list past the policy cap instead of storing it whole', async () => {
    const cache = new ModelListsCache(
      createMemoryModelListCacheStorage(),
      { ...DEFAULT_MODEL_LIST_CACHE_POLICY, maxModels: 2 },
    );
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('hetzner', PROJECT)).toHaveLength(2);
  });

  it('selects expired and over-cap keys for eviction', () => {
    const now = 1_000_000;
    const entry = (host: string, projectPath: string, savedAtMs: number): Parameters<
      typeof selectModelListCacheEvictions
    >[0][number] => ({ host, projectPath, schema: MODEL_LIST_CACHE_SCHEMA, models: [], savedAtMs });
    const entries = [
      entry('hetzner', '/fresher', now - 5),
      entry('hetzner', '/fresh', now - 10),
      entry('hetzner', '/old', now - DEFAULT_MODEL_LIST_CACHE_POLICY.ttlMs - 1),
    ];
    // One slot under the cap: the freshest stays; the other fresh list and
    // the expired one go.
    const evictions = selectModelListCacheEvictions(entries, now, {
      ...DEFAULT_MODEL_LIST_CACHE_POLICY,
      maxLists: 1,
    });
    expect(evictions).toEqual([
      { host: 'hetzner', projectPath: '/old' },
      { host: 'hetzner', projectPath: '/fresh' },
    ]);
  });

  it('discards a stored entry whose shape a newer or corrupted writer left behind', () => {
    expect(isUsableModelListCacheEntry({
      host: 'hetzner',
      projectPath: PROJECT,
      schema: MODEL_LIST_CACHE_SCHEMA + 1,
      models: MODELS,
      savedAtMs: 1,
    })).toBe(false);
    expect(isUsableModelListCacheEntry({
      host: 'hetzner',
      projectPath: PROJECT,
      schema: MODEL_LIST_CACHE_SCHEMA,
      models: [{ value: '', label: 'x' }],
      savedAtMs: 1,
    })).toBe(false);
    expect(isUsableModelListCacheEntry({
      host: 'hetzner',
      projectPath: PROJECT,
      schema: MODEL_LIST_CACHE_SCHEMA,
      models: 'anthropic/claude-sonnet-4',
      savedAtMs: 1,
    })).toBe(false);
  });

  it('round-trips through a localStorage-shaped store and survives junk in it', async () => {
    const storage = fakeStorage({
      [MODEL_LISTS_CACHE_STORAGE_KEY]: JSON.stringify([
        { host: 'hetzner', projectPath: PROJECT, schema: MODEL_LIST_CACHE_SCHEMA, models: MODELS, savedAtMs: 5 },
        { nonsense: true },
      ]),
    });
    // A fixed clock makes the seeded savedAtMs (5) unexpired at now (10).
    const cache = new ModelListsCache(createLocalModelListCacheStorage(storage)!, DEFAULT_MODEL_LIST_CACHE_POLICY, () => 10);

    expect(await cache.load('hetzner', PROJECT)).toEqual(MODELS);

    // A save rewrites the record without duplicating that list's entry.
    await cache.save('hetzner', PROJECT, [model('openai/gpt-5')]);
    const record = JSON.parse(storage.raw.get(MODEL_LISTS_CACHE_STORAGE_KEY) ?? '[]') as unknown[];
    expect(record.filter((entry) => (entry as { projectPath?: string }).projectPath === PROJECT))
      .toHaveLength(1);
    expect(await cache.load('hetzner', PROJECT)).toEqual([model('openai/gpt-5')]);
  });

  it('ignores malformed JSON in the store rather than throwing', async () => {
    const storage = fakeStorage({ [MODEL_LISTS_CACHE_STORAGE_KEY]: '{not json' });
    const cache = new ModelListsCache(createLocalModelListCacheStorage(storage)!);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('keeps working when localStorage itself throws', async () => {
    const storage = fakeStorage();
    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    const cache = new ModelListsCache(createLocalModelListCacheStorage(storage)!);
    await cache.save('hetzner', PROJECT, MODELS);
    expect(await cache.load('hetzner', PROJECT)).toBeNull();
  });

  it('falls back to memory storage when none exists', () => {
    expect(createLocalModelListCacheStorage(null)).toBeNull();
  });
});
