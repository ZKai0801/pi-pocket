import { describe, expect, it, vi } from 'vitest';
import type { PiSessionMeta } from '../../src/pi/piRepository';
import { createSessionsStore } from '../../src/stores/sessions';

const session = { version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] };

describe('sessions store', () => {
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
});
