import { describe, expect, it, vi } from 'vitest';
import type { PiProject, PiSessionMeta } from '../../src/pi/piRepository';
import type { ParsedPiSession } from '../../src/pi/types';
import { clampTurnPollInterval, createSessionsStore } from '../../src/stores/sessions';

const session: ParsedPiSession = { version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sessions store', () => {
  const meta = (id: string, updatedAtMs: number): PiSessionMeta => ({ path: `/r/${id}.jsonl`, id, name: id, updatedAtMs, preview: 'p', turnCount: 1 });

  it('loads a project session list', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(async () => [{ path: '/r/a.jsonl', id: 'a', name: 'n', updatedAtMs: 1, preview: 'p', turnCount: 2 }]), readSession: vi.fn() } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    expect(store.sessions).toHaveLength(1);
    expect(store.state).toBe('ready');
  });

  it('opens a session into turns', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(async () => ({ version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] })) } as never);
    await store.openSession('/r/a.jsonl');
    expect(store.open?.turns).toHaveLength(1);
  });

  it('reports error instead of an empty list when the read fails', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(async () => { throw new Error('sftp failed'); }), readSession: vi.fn() } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    expect(store.state).toBe('error');
    expect(store.error).toContain('sftp failed');
  });

  it('closeChat clears the open session and its path', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(async () => session) } as never);
    await store.openSession('/r/a.jsonl');
    expect(store.openPath).toBe('/r/a.jsonl');
    store.closeChat();
    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
  });

  it('refresh re-reads the open session by its path', async () => {
    const readSession = vi.fn(async () => ({
      ...session,
      turns: [...session.turns, { role: 'assistant', text: 'more', timestampMs: 2 }],
    }));
    const store = createSessionsStore({ listSessions: vi.fn(), readSession } as never);
    await store.openSession('/r/a.jsonl');
    await store.refresh();
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(readSession).toHaveBeenLastCalledWith('/r/a.jsonl');
    expect(store.open?.turns).toHaveLength(2);
  });

  it('refresh does nothing without a project and no open chat', async () => {
    const listSessions = vi.fn();
    const readSession = vi.fn();
    const store = createSessionsStore({ listSessions, readSession } as never);
    await store.refresh();
    expect(listSessions).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(store.state).toBe('idle');
  });

  it('does not start a second load while one is in flight', async () => {
    let resolveList!: (value: PiSessionMeta[]) => void;
    const listSessions = vi.fn(
      () =>
        new Promise<PiSessionMeta[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const store = createSessionsStore({ listSessions, readSession: vi.fn() } as never);
    const first = store.load({ path: '/home/kai', name: 'kai' });
    const second = store.load({ path: '/home/kai', name: 'kai' });
    expect(listSessions).toHaveBeenCalledTimes(1);
    resolveList([]);
    await first;
    await second;
    expect(store.state).toBe('ready');
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous chat intact when a re-read fails', async () => {
    let fail = false;
    const readSession = vi.fn(async () => {
      if (fail) throw new Error('sftp failed');
      return session;
    });
    const store = createSessionsStore({ listSessions: vi.fn(), readSession } as never);
    await store.openSession('/r/a.jsonl');
    expect(store.state).toBe('ready');
    fail = true;
    await store.refresh();
    expect(store.state).toBe('error');
    expect(store.error).toContain('sftp failed');
    expect(store.open?.turns).toHaveLength(1);
    expect(store.openPath).toBe('/r/a.jsonl');
  });

  it('clamps the turn poll interval to the shared floor', () => {
    expect(clampTurnPollInterval(50)).toBe(250);
    expect(clampTurnPollInterval(250)).toBe(250);
    expect(clampTurnPollInterval(1_000)).toBe(1_000);
  });

  it('host switch: drops a load result that resolves after the host changed', async () => {
    const list = deferred<PiSessionMeta[]>();
    const listSessions = vi.fn(() => list.promise);
    let host = 'A';
    const store = createSessionsStore({ listSessions, readSession: vi.fn(), hostId: () => host } as never);
    const first = store.load({ path: '/p/a', name: 'a' });
    host = 'B';
    store.hostChanged();
    list.resolve([meta('a', 1)]);
    await first;
    expect(store.sessions).toHaveLength(0);
    expect(store.state).not.toBe('ready');
    expect(store.lastProject).toBeNull();
  });

  it('host switch: drops an open-session result that resolves after the host changed', async () => {
    const read = deferred<ParsedPiSession>();
    const readSession = vi.fn(() => read.promise);
    let host = 'A';
    const store = createSessionsStore({ listSessions: vi.fn(), readSession, hostId: () => host } as never);
    const first = store.openSession('/r/a.jsonl');
    host = 'B';
    store.hostChanged();
    read.resolve(session);
    await first;
    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
    expect(store.state).not.toBe('ready');
  });

  it('host switch: starts a fresh run for another project on the same host, and the stale run cannot wipe the fresh claim', async () => {
    const pendA = deferred<PiSessionMeta[]>();
    const pendB = deferred<PiSessionMeta[]>();
    const listSessions = vi.fn((project: PiProject) => (project.path === '/p/a' ? pendA.promise : pendB.promise));
    const store = createSessionsStore({ listSessions, readSession: vi.fn(), hostId: () => 'A' } as never);
    const first = store.load({ path: '/p/a', name: 'a' });
    const second = store.load({ path: '/p/b', name: 'b' });
    // Not swallowed: P_B got its own listSessions.
    expect(listSessions).toHaveBeenCalledTimes(2);
    // While P_B's run is still in flight, a third load of P_B joins it.
    const third = store.load({ path: '/p/b', name: 'b' });
    expect(listSessions).toHaveBeenCalledTimes(2);
    pendA.resolve([meta('a', 1)]);
    await first;
    // A's stale result is dropped; P_B's claim is still in flight.
    expect(store.sessions).toHaveLength(0);
    pendB.resolve([meta('b1', 2), meta('b2', 3)]);
    await second;
    await third;
    expect(store.sessions).toHaveLength(2);
    expect(store.lastProject?.path).toBe('/p/b');
    expect(store.state).toBe('ready');
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('host switch: joins a same-host same-project double load when a hostId dep is wired', async () => {
    const pend = deferred<PiSessionMeta[]>();
    const listSessions = vi.fn(() => pend.promise);
    const store = createSessionsStore({ listSessions, readSession: vi.fn(), hostId: () => 'A' } as never);
    const first = store.load({ path: '/p/a', name: 'a' });
    const second = store.load({ path: '/p/a', name: 'a' });
    expect(listSessions).toHaveBeenCalledTimes(1);
    pend.resolve([]);
    await first;
    await second;
    expect(store.state).toBe('ready');
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('host switch: does not re-join a run invalidated by a host switch, even when the host returns', async () => {
    const pendStale = deferred<PiSessionMeta[]>();
    const pendFresh = deferred<PiSessionMeta[]>();
    let calls = 0;
    const listSessions = vi.fn(() => {
      calls += 1;
      return calls === 1 ? pendStale.promise : pendFresh.promise;
    });
    let host = 'A';
    const store = createSessionsStore({ listSessions, readSession: vi.fn(), hostId: () => host } as never);
    const first = store.load({ path: '/p/a', name: 'a' });
    host = 'B';
    store.hostChanged();
    host = 'A';
    const second = store.load({ path: '/p/a', name: 'a' });
    expect(listSessions).toHaveBeenCalledTimes(2);
    pendStale.resolve([meta('stale', 1)]);
    await first;
    expect(store.sessions).toHaveLength(0);
    pendFresh.resolve([meta('fresh', 2)]);
    await second;
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.id).toBe('fresh');
    expect(store.state).toBe('ready');
  });
});

describe('sessions store session backup', () => {
  const backup: ParsedPiSession = {
    version: 3,
    id: 'a',
    cwd: '/home/kai',
    name: null,
    turns: [{ role: 'user', text: 'old', timestampMs: 1 }],
  };
  const fresh: ParsedPiSession = {
    ...backup,
    turns: [...backup.turns, { role: 'assistant', text: 'new', timestampMs: 2 }],
  };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('paints the local backup instantly and replaces it with the fresh read', async () => {
    const read = deferred<ParsedPiSession>();
    const loadCachedSession = vi.fn(async () => backup);
    const saveCachedSession = vi.fn(async () => {});
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: () => read.promise,
      loadCachedSession,
      saveCachedSession,
    } as never);

    const opened = store.openSession('/r/a.jsonl');
    await tick();
    // The backup is on screen while the server read is still in flight.
    expect(store.open).toEqual(backup);
    expect(store.state).toBe('ready');
    expect(loadCachedSession).toHaveBeenCalledWith(null, '/r/a.jsonl');

    read.resolve(fresh);
    await opened;
    expect(store.open).toEqual(fresh);
    expect(store.state).toBe('ready');
    expect(saveCachedSession).toHaveBeenCalledWith(null, '/r/a.jsonl', fresh);
  });

  it('keeps the cold-open spinner path on a backup miss', async () => {
    const read = deferred<ParsedPiSession>();
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: () => read.promise,
      loadCachedSession: vi.fn(async () => null),
      saveCachedSession: vi.fn(async () => {}),
    } as never);

    const opened = store.openSession('/r/a.jsonl');
    await tick();
    expect(store.open).toBeNull();
    expect(store.state).toBe('loading');

    read.resolve(fresh);
    await opened;
    expect(store.open).toEqual(fresh);
    expect(store.state).toBe('ready');
  });

  it('keeps the painted backup and shows the error when the server read fails', async () => {
    const saveCachedSession = vi.fn(async () => {});
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => {
        throw new Error('sftp failed');
      }),
      loadCachedSession: vi.fn(async () => backup),
      saveCachedSession,
    } as never);

    await store.openSession('/r/a.jsonl');
    expect(store.open).toEqual(backup);
    expect(store.state).toBe('error');
    expect(store.error).toContain('sftp failed');
    expect(store.openPath).toBe('/r/a.jsonl');
    // A failed read is never remembered as the conversation's state.
    expect(saveCachedSession).not.toHaveBeenCalled();
  });

  it('swallows a backup load failure and opens from the server read alone', async () => {
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => fresh),
      loadCachedSession: vi.fn(async () => {
        throw new Error('idb blocked');
      }),
      saveCachedSession: vi.fn(async () => {}),
    } as never);

    await store.openSession('/r/a.jsonl');
    expect(store.open).toEqual(fresh);
    expect(store.state).toBe('ready');
    expect(store.error).toBeNull();
  });

  it('does not repaint the backup when refreshing the open chat', async () => {
    const loadCachedSession = vi.fn(async () => backup);
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => fresh),
      loadCachedSession,
      saveCachedSession: vi.fn(async () => {}),
    } as never);

    await store.openSession('/r/a.jsonl');
    expect(loadCachedSession).toHaveBeenCalledTimes(1);

    await store.refresh();
    expect(loadCachedSession).toHaveBeenCalledTimes(1);
    expect(store.open).toEqual(fresh);
    expect(store.state).toBe('ready');
  });

  it('host switch: drops a backup that resolves after the host changed', async () => {
    const backupLoaded = deferred<ParsedPiSession | null>();
    const read = deferred<ParsedPiSession>();
    let host = 'A';
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: () => read.promise,
      loadCachedSession: () => backupLoaded.promise,
      saveCachedSession: vi.fn(async () => {}),
      hostId: () => host,
    } as never);

    const opened = store.openSession('/r/a.jsonl');
    host = 'B';
    store.hostChanged();
    backupLoaded.resolve(backup);
    read.resolve(fresh);
    await opened;

    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
    expect(store.state).not.toBe('ready');
  });

  it('remembers the fresh parse after a turn in the open chat', async () => {
    const replied: ParsedPiSession = {
      ...backup,
      turns: [...backup.turns, { role: 'assistant', text: 'ok', timestampMs: 3 }],
    };
    const runner = {
      send: vi.fn(async () => ({ ok: true as const, session: replied })),
      startNew: vi.fn(),
      isBusy: vi.fn(() => false),
      dispose: vi.fn(),
    };
    const saveCachedSession = vi.fn(async () => {});
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => fresh),
      runner,
      saveCachedSession,
      hostId: () => 'alexey',
    } as never);

    await store.openSession('/r/a.jsonl');
    expect(await store.send('hi')).toBe('sent');
    expect(saveCachedSession).toHaveBeenLastCalledWith('alexey', '/r/a.jsonl', replied);
  });

  it('remembers the fresh parse under the adopted file after a draft turn', async () => {
    const replied: ParsedPiSession = {
      ...backup,
      turns: [...backup.turns, { role: 'assistant', text: 'ok', timestampMs: 3 }],
    };
    const runner = {
      send: vi.fn(),
      startNew: vi.fn(async () => ({ ok: true as const, sessionFile: '/r/new.jsonl', session: replied })),
      isBusy: vi.fn(() => false),
      dispose: vi.fn(),
    };
    const saveCachedSession = vi.fn(async () => {});
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => fresh),
      runner,
      saveCachedSession,
      hostId: () => 'alexey',
    } as never);

    store.newConversation({ path: '/home/kai', name: 'kai' });
    expect(await store.send('hi')).toBe('sent');
    expect(saveCachedSession).toHaveBeenCalledTimes(1);
    expect(saveCachedSession).toHaveBeenCalledWith('alexey', '/r/new.jsonl', replied);
  });

  it('does not remember anything when the turn fails', async () => {
    const runner = {
      send: vi.fn(async () => ({ ok: false as const, error: 'The turn timed out before Pi wrote a new assistant reply.' })),
      startNew: vi.fn(),
      isBusy: vi.fn(() => false),
      dispose: vi.fn(),
    };
    const saveCachedSession = vi.fn(async () => {});
    const store = createSessionsStore({
      listSessions: vi.fn(),
      readSession: vi.fn(async () => fresh),
      runner,
      saveCachedSession,
      hostId: () => 'alexey',
    } as never);

    await store.openSession('/r/a.jsonl');
    expect(await store.send('hi')).toBe('error');
    // Only the open's save; the failed turn wrote nothing.
    expect(saveCachedSession).toHaveBeenCalledTimes(1);
  });
});
