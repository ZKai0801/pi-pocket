// tests/unit/projectsStoreCache.test.ts
/**
 * The 项目 tab's cached paint (spec §8.5): a reconnect must show the host's
 * last known projects at once, with the fresh listing correcting them behind
 * it. These tests pin the order (backup before network), the merge with the
 * manually added projects, and the failure rule: a refresh that fails keeps a
 * usable list instead of replacing it with an error screen.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProjectsStore } from '../../src/stores/projects';

const CACHED = [
  { path: '/home/kai/git/pocketshell', name: 'pocketshell' },
  { path: '/home/kai/git/aplexer', name: 'aplexer' },
];

interface CacheStub {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

/** The store's cache dep: a hit by default, overridable per test. */
function cache(over: Partial<CacheStub> = {}): CacheStub {
  return {
    load: vi.fn(async () => CACHED),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    resolveRoot: vi.fn(async () => '/root'),
    listProjects: vi.fn(async () => [{ path: '/home/kai/git/fresh', name: 'fresh' }]),
    ...over,
  };
}

/** Let queued microtasks (the added load and the cache read) settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('projects store cache', () => {
  it('paints the remembered list while the server listing is still in flight', async () => {
    let releaseRoot: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    const store = createProjectsStore(deps({
      resolveRoot: vi.fn(async () => { await gate; return '/root'; }),
      cache: cache(),
    }) as never);

    const running = store.discover();
    await flush();

    // The listing has not even started: the list is already on screen.
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual(CACHED);
    expect(store.stale).toBe(true);
    expect(store.refreshing).toBe(true);

    releaseRoot();
    await running;
    expect(store.projects).toEqual([{ path: '/home/kai/git/fresh', name: 'fresh' }]);
    expect(store.stale).toBe(false);
    expect(store.refreshing).toBe(false);
  });

  it('replaces the painted list with the fresh one and remembers it', async () => {
    const stored = cache();
    const store = createProjectsStore(deps({ cache: stored }) as never);
    await store.discover();
    expect(store.projects).toEqual([{ path: '/home/kai/git/fresh', name: 'fresh' }]);
    expect(stored.save).toHaveBeenCalledWith([{ path: '/home/kai/git/fresh', name: 'fresh' }]);
  });

  it('keeps the painted list when the refresh fails, and says it is stale', async () => {
    const store = createProjectsStore(deps({
      listProjects: vi.fn(async () => { throw new Error('exec 255'); }),
      cache: cache(),
    }) as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual(CACHED);
    expect(store.stale).toBe(true);
    expect(store.error).toContain('exec 255');
    expect(store.refreshing).toBe(false);
  });

  it('still reports an error when there is no backup to fall back on', async () => {
    const store = createProjectsStore(deps({
      listProjects: vi.fn(async () => { throw new Error('exec 255'); }),
      cache: cache({ load: vi.fn(async () => null) }),
    }) as never);
    await store.discover();
    expect(store.state).toBe('error');
    expect(store.projects).toEqual([]);
    expect(store.stale).toBe(false);
  });

  it('drops the backup when the probe finds no session root', async () => {
    const stored = cache();
    const store = createProjectsStore(deps({
      resolveRoot: vi.fn(async () => null),
      cache: stored,
    }) as never);
    await store.discover();
    expect(store.state).toBe('no-root');
    expect(store.projects).toEqual([]);
    expect(store.stale).toBe(false);
    // A root that is not there makes the remembered list wrong, not stale.
    expect(stored.clear).toHaveBeenCalledTimes(1);
  });

  it('merges the manually added projects behind the cached ones', async () => {
    let releaseRoot: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    const added = { load: vi.fn(async () => ['/home/kai/git/fresh']), save: vi.fn(async () => undefined) };
    const store = createProjectsStore(deps({
      resolveRoot: vi.fn(async () => { await gate; return '/root'; }),
      cache: cache(),
      added,
    }) as never);
    const running = store.discover();
    await flush();
    expect(store.projects.map((project) => project.path)).toEqual([
      '/home/kai/git/pocketshell',
      '/home/kai/git/aplexer',
      '/home/kai/git/fresh',
    ]);
    releaseRoot();
    await running;
  });

  it('treats a cache that cannot be read or written as a miss', async () => {
    const broken = cache({
      load: vi.fn(async () => { throw new Error('storage unavailable'); }),
      save: vi.fn(async () => { throw new Error('quota'); }),
    });
    const store = createProjectsStore(deps({ cache: broken }) as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/home/kai/git/fresh', name: 'fresh' }]);
  });

  it('drops the backup before rescanning a re-pointed session root', async () => {
    const stored = cache();
    const store = createProjectsStore(deps({
      cache: stored,
      setPiSessionsDir: vi.fn(),
    }) as never);
    await store.savePiSessionsDir('hetzner', '/srv/pi/sessions');
    expect(stored.clear).toHaveBeenCalledTimes(1);
    // The clear must precede the re-discover's read, or the old root's list
    // would paint over the new one.
    expect(stored.clear.mock.invocationCallOrder[0])
      .toBeLessThan(stored.load.mock.invocationCallOrder[0]);
  });

  it('discovers without a cache dep exactly as before', async () => {
    const store = createProjectsStore(deps() as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/home/kai/git/fresh', name: 'fresh' }]);
    expect(store.stale).toBe(false);
  });
});
