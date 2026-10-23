// tests/unit/sessionsStoreCache.test.ts
/**
 * The 会话 tab's cached paint (spec §8.5): entering a project after a reconnect
 * must show its conversations at once, with the server's listing correcting
 * them behind it. These tests pin the order (backup before listing), the rule
 * that a failed sync keeps usable rows instead of an error screen, and the two
 * cases where painting would be wrong: another project's rows, and a list the
 * user is already looking at.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PiSessionMeta } from '../../src/pi/piRepository';
import { createSessionsStore } from '../../src/stores/sessions';

const PROJECT = { path: '/home/kai/git/pocketshell', name: 'pocketshell' };
const OTHER = { path: '/home/kai/git/aplexer', name: 'aplexer' };

function row(id: string, updatedAtMs = 1): PiSessionMeta {
  return { path: `/root/${id}.jsonl`, id, name: id, updatedAtMs, preview: id, turnCount: 1 };
}

const CACHED = [row('cached-1', 2), row('cached-2', 1)];
const FRESH = [row('fresh', 3)];

type CacheStub = {
  loadCachedSessions: ReturnType<typeof vi.fn>;
  saveCachedSessions: ReturnType<typeof vi.fn>;
};

/** The store's list-cache deps: a hit by default, overridable per test. */
function cache(over: Partial<CacheStub> = {}): CacheStub {
  return {
    loadCachedSessions: vi.fn(async () => CACHED),
    saveCachedSessions: vi.fn(async () => undefined),
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    listSessions: vi.fn(async () => FRESH),
    readSession: vi.fn(),
    hostId: () => 'hetzner',
    ...over,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Let the cache read (a microtask) settle before the listing is inspected. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('sessions store list cache', () => {
  it('paints the remembered rows while the server listing is still in flight', async () => {
    const gate = deferred<PiSessionMeta[]>();
    const store = createSessionsStore(
      deps({ listSessions: vi.fn(() => gate.promise), ...cache() }) as never,
    );

    const running = store.load(PROJECT);
    await flush();

    // The listing has not resolved: the rows are already on screen.
    expect(store.state).toBe('ready');
    expect(store.sessions).toEqual(CACHED);
    expect(store.stale).toBe(true);
    expect(store.refreshing).toBe(true);
    // The painted rows belong to this project, so the + and the empty text
    // already answer for it.
    expect(store.lastProject).toEqual(PROJECT);

    gate.resolve(FRESH);
    await running;
    expect(store.sessions).toEqual(FRESH);
    expect(store.stale).toBe(false);
    expect(store.refreshing).toBe(false);
  });

  it('replaces the painted rows with the fresh listing and remembers it', async () => {
    const stored = cache();
    const store = createSessionsStore(deps(stored) as never);
    await store.load(PROJECT);
    expect(store.sessions).toEqual(FRESH);
    expect(stored.saveCachedSessions).toHaveBeenCalledWith('hetzner', PROJECT.path, FRESH);
  });

  it('keys the write to the host it listed on', async () => {
    const stored = cache();
    const store = createSessionsStore(
      deps({ ...stored, hostId: () => 'other-box' }) as never,
    );
    await store.load(PROJECT);
    expect(stored.loadCachedSessions).toHaveBeenCalledWith('other-box', PROJECT.path);
    expect(stored.saveCachedSessions).toHaveBeenCalledWith('other-box', PROJECT.path, FRESH);
  });

  it('keeps the painted rows when the sync fails, and says they are stale', async () => {
    const store = createSessionsStore(
      deps({
        listSessions: vi.fn(async () => { throw new Error('exec 255'); }),
        ...cache(),
      }) as never,
    );
    await store.load(PROJECT);
    expect(store.state).toBe('ready');
    expect(store.sessions).toEqual(CACHED);
    expect(store.stale).toBe(true);
    expect(store.error).toContain('exec 255');
    expect(store.refreshing).toBe(false);
  });

  it('still reports an error when there is no backup to fall back on', async () => {
    const store = createSessionsStore(
      deps({
        listSessions: vi.fn(async () => { throw new Error('exec 255'); }),
        ...cache({ loadCachedSessions: vi.fn(async () => null) }),
      }) as never,
    );
    await store.load(PROJECT);
    expect(store.state).toBe('error');
    expect(store.sessions).toEqual([]);
    expect(store.stale).toBe(false);
  });

  it('lets the retry button reload the project that failed', async () => {
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error('exec 255'))
      .mockResolvedValueOnce(FRESH);
    const store = createSessionsStore(
      deps({ listSessions, ...cache({ loadCachedSessions: vi.fn(async () => null) }) }) as never,
    );
    await store.load(PROJECT);
    expect(store.state).toBe('error');
    await store.refresh();
    expect(store.state).toBe('ready');
    expect(store.sessions).toEqual(FRESH);
  });

  it('never repaints older rows under a list the user is already looking at', async () => {
    const gate = deferred<PiSessionMeta[]>();
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(FRESH)
      .mockImplementationOnce(() => gate.promise);
    const stored = cache();
    const store = createSessionsStore(deps({ listSessions, ...stored }) as never);

    await store.load(PROJECT);
    expect(store.sessions).toEqual(FRESH);

    const reload = store.load(PROJECT);
    await flush();
    // The refresh is in flight, and the screen still shows the confirmed rows
    // rather than falling back to the older backup.
    expect(stored.loadCachedSessions).toHaveBeenCalledTimes(1);
    expect(store.sessions).toEqual(FRESH);
    expect(store.state).toBe('ready');

    gate.resolve([row('newer', 4)]);
    await reload;
    expect(store.sessions).toEqual([row('newer', 4)]);
  });

  it('paints the next project\'s rows after a switch, not the last project\'s', async () => {
    const listSessions = vi.fn(async () => FRESH);
    const loadedFor: string[] = [];
    const loadCachedSessions = vi.fn(async (_host: string | null, projectPath: string) => {
      loadedFor.push(projectPath);
      return projectPath === OTHER.path ? [row('other')] : CACHED;
    });
    const store = createSessionsStore(
      deps({ listSessions, loadCachedSessions, saveCachedSessions: vi.fn() }) as never,
    );

    await store.load(PROJECT);
    const gate = deferred<PiSessionMeta[]>();
    listSessions.mockImplementationOnce(() => gate.promise);
    const switching = store.load(OTHER);
    await flush();

    expect(loadedFor).toEqual([PROJECT.path, OTHER.path]);
    expect(store.sessions).toEqual([row('other')]);
    expect(store.lastProject).toEqual(OTHER);

    gate.resolve(FRESH);
    await switching;
    expect(store.sessions).toEqual(FRESH);
  });

  it('treats a cache that cannot be read or written as a miss', async () => {
    const broken = cache({
      loadCachedSessions: vi.fn(async () => { throw new Error('storage unavailable'); }),
      saveCachedSessions: vi.fn(async () => { throw new Error('quota'); }),
    });
    const store = createSessionsStore(deps(broken) as never);
    await store.load(PROJECT);
    expect(store.state).toBe('ready');
    expect(store.sessions).toEqual(FRESH);
    expect(store.stale).toBe(false);
  });

  it('drops the stale marker when the host changes', async () => {
    let host: string | null = 'hetzner';
    const store = createSessionsStore(
      deps({ ...cache(), hostId: () => host }) as never,
    );
    await store.load(PROJECT);
    store.stale = true;
    store.refreshing = true;
    host = 'other-box';
    store.hostChanged();
    expect(store.stale).toBe(false);
    expect(store.refreshing).toBe(false);
  });

  it('loads without a cache dep exactly as before', async () => {
    const listSessions = vi.fn(async () => FRESH);
    const store = createSessionsStore({ listSessions, readSession: vi.fn() } as never);
    const running = store.load(PROJECT);
    // No cache dep means no await before the listing: the claim is synchronous.
    expect(listSessions).toHaveBeenCalledTimes(1);
    await running;
    expect(store.state).toBe('ready');
    expect(store.stale).toBe(false);
  });
});
