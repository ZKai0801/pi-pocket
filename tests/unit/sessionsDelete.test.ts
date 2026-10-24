import { describe, expect, it, vi } from 'vitest';
import { createSessionsStore } from '../../src/stores/sessions';
import type { ParsedPiSession } from '../../src/pi/types';
import type { PiSessionMeta } from '../../src/pi/piRepository';
import type { RecentSessionEntry } from '../../src/pi/recentSessionsCache';

const A = '/root/a.jsonl';
const B = '/root/b.jsonl';
const C = '/root/c.jsonl';

const SESSION: ParsedPiSession = {
  version: 3,
  id: 'a',
  cwd: '/home/kai',
  name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

function meta(path: string, id = path): PiSessionMeta {
  return { path, id, name: null, updatedAtMs: 1, preview: 'p', turnCount: 1 };
}

function recent(path: string): RecentSessionEntry {
  return {
    path,
    id: path,
    name: null,
    updatedAtMs: 1,
    preview: 'p',
    turnCount: 1,
    projectPath: '/home/kai',
    openedAtMs: 1,
  } as RecentSessionEntry;
}

interface Harness {
  store: ReturnType<typeof createSessionsStore>;
  removed: string[];
  forgotten: string[];
  saved: Array<readonly PiSessionMeta[]>;
}

/** A store whose destructive half is observable: every removal recorded. */
function harness(options: {
  fail?: string | null;
  running?: string[];
  host?: string | null;
} = {}): Harness {
  const removed: string[] = [];
  const forgotten: string[] = [];
  const saved: Array<readonly PiSessionMeta[]> = [];
  const running = options.running ?? [];
  const store = createSessionsStore({
    listSessions: vi.fn(async () => [meta(A), meta(B), meta(C)]),
    readSession: vi.fn(async () => SESSION),
    deleteSession: vi.fn(async (path: string) => {
      if (options.fail !== undefined && options.fail !== null && path === options.fail) {
        throw new Error('read-only file system');
      }
      removed.push(path);
    }),
    forgetSession: vi.fn(async (_host: string | null, path: string) => {
      forgotten.push(path);
    }),
    saveCachedSessions: vi.fn(async (_host, _projectPath, sessions) => {
      saved.push([...sessions]);
    }),
    hostId: () => (options.host === undefined ? 'hetzner' : options.host),
  } as never);
  for (const path of running) store.running = [...store.running, path];
  return { store, removed, forgotten, saved };
}

describe('sessions store deletion', () => {
  it('a long-press enters the tick list with that row ticked', () => {
    const { store } = harness();
    expect(store.selecting).toBe(false);

    store.startSelection(B);
    expect(store.selecting).toBe(true);
    expect(store.selected).toEqual([B]);
  });

  it('a second long-press on a ticked row keeps it ticked once', () => {
    const { store } = harness();
    store.startSelection(A);
    store.startSelection(A);
    expect(store.selected).toEqual([A]);
  });

  it('a tap inside the tick list ticks and unticks', () => {
    const { store } = harness();
    store.startSelection(A);
    store.toggleSelected(B);
    expect(store.selected).toEqual([A, B]);
    store.toggleSelected(A);
    expect(store.selected).toEqual([B]);
  });

  it('a conversation with a turn in flight cannot be ticked', () => {
    const { store } = harness({ running: [A] });
    // The long-press still arms the mode — the row just has nothing to offer.
    store.startSelection(A);
    expect(store.selecting).toBe(true);
    expect(store.selected).toEqual([]);

    store.toggleSelected(A);
    expect(store.selected).toEqual([]);
  });

  it('全选 ticks only what can go, and 取消全选 clears the ticks', async () => {
    const { store } = harness({ running: [B] });
    await store.load({ path: '/home/kai', name: 'kai' });

    store.setAllSelected(true, [A, B, C]);
    expect(store.selected).toEqual([A, C]);

    store.setAllSelected(false, [A, B, C]);
    expect(store.selected).toEqual([]);
  });

  it('deletes every ticked conversation and drops it from the list', async () => {
    const { store, removed, forgotten } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    store.startSelection(A);
    store.toggleSelected(C);

    const count = await store.deleteSelected();

    expect(count).toBe(2);
    expect(removed).toEqual([A, C]);
    // The list keeps only what is still on the host.
    expect(store.sessions.map((row) => row.path)).toEqual([B]);
    // Their local backups went with them.
    expect(forgotten).toEqual([A, C]);
    // A clean sweep leaves the mode.
    expect(store.selecting).toBe(false);
    expect(store.selected).toEqual([]);
    expect(store.deleteError).toBeNull();
  });

  it('drops a deleted conversation from the 最近打开 list too', async () => {
    const { store } = harness();
    // `recents` is read-only on the interface; the reactive store takes a write.
    (store as unknown as { recents: RecentSessionEntry[] }).recents = [recent(A), recent(B)];
    store.startSelection(A);

    await store.deleteSelected();

    expect(store.recents.map((row) => row.path)).toEqual([B]);
  });

  it('skips a conversation whose turn starts after it was ticked', async () => {
    const { store, removed } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    store.setAllSelected(true, [A, B, C]);
    expect(store.selected).toEqual([A, B, C]);
    // A turn starts in B while the user is still deciding.
    store.running = [...store.running, B];

    const count = await store.deleteSelected();

    expect(count).toBe(2);
    expect(removed).toEqual([A, C]);
    // The running one is still there, and still ticked so the user can see
    // what was left behind.
    expect(store.sessions.map((row) => row.path)).toEqual([B]);
    expect(store.selected).toEqual([B]);
    expect(store.deleteError).toBeNull();
  });

  it('refuses to delete when every tick names a running conversation', async () => {
    const { store, removed } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    store.setAllSelected(true, [A, B]);
    store.running = [A, B];

    const count = await store.deleteSelected();

    expect(count).toBe(0);
    expect(removed).toEqual([]);
    expect(store.deleteError).toBe('选中的会话都还在跑，等它们结束再删。');
  });

  it('keeps a failed conversation ticked and says why in Chinese', async () => {
    const { store, removed } = harness({ fail: C });
    await store.load({ path: '/home/kai', name: 'kai' });
    store.startSelection(A);
    store.setAllSelected(true, [A, B, C]);

    const count = await store.deleteSelected();

    // The sweep stops at the failure: what is still ticked is still on the host.
    expect(count).toBe(2);
    expect(removed).toEqual([A, B]);
    expect(store.selected).toEqual([C]);
    expect(store.selecting).toBe(true);
    expect(store.deleteError).toBe('删除失败：read-only file system');
  });

  it('closes the chat when the conversation on screen is deleted', async () => {
    const { store } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    await store.openSession(A);
    expect(store.openPath).toBe(A);

    store.startSelection(A);
    await store.deleteSelected();

    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
  });

  it('leaves the chat alone when another conversation is deleted', async () => {
    const { store } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    await store.openSession(A);

    store.startSelection(B);
    await store.deleteSelected();

    expect(store.openPath).toBe(A);
  });

  it('does nothing when nothing is ticked', async () => {
    const { store, removed } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });

    expect(await store.deleteSelected()).toBe(0);
    expect(removed).toEqual([]);
  });

  it('reports an unreachable host instead of pretending it deleted', async () => {
    const store = createSessionsStore({
      listSessions: vi.fn(async () => [meta(A)]),
      readSession: vi.fn(async () => SESSION),
      hostId: () => null,
    } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    store.startSelection(A);

    expect(await store.deleteSelected()).toBe(0);
    expect(store.deleteError).toBe('没有连接，暂时无法删除会话。');
  });

  it('a host switch under the sweep abandons the rest', async () => {
    let host = 'hetzner';
    const removed: string[] = [];
    const store = createSessionsStore({
      listSessions: vi.fn(async () => [meta(A), meta(B)]),
      readSession: vi.fn(async () => SESSION),
      deleteSession: vi.fn(async (path: string) => {
        removed.push(path);
        // The connection drops between the two removals.
        if (path === A) host = 'other';
      }),
      hostId: () => host,
    } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    store.setAllSelected(true, [A, B]);

    const count = await store.deleteSelected();

    // The first went and its row went with it; the second was never asked
    // for, because the path it holds names a file on the host just left.
    expect(removed).toEqual([A]);
    expect(count).toBe(1);
    expect(store.sessions.map((row) => row.path)).toEqual([B]);
  });

  it('cancelSelection leaves the mode without touching any file', async () => {
    const { store, removed } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    store.startSelection(A);
    store.toggleSelected(B);

    store.cancelSelection();

    expect(store.selecting).toBe(false);
    expect(store.selected).toEqual([]);
    expect(removed).toEqual([]);
    expect(store.sessions).toHaveLength(3);
  });

  it('a host switch drops the ticks with the host that owned them', async () => {
    const { store, removed } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    store.startSelection(A);

    store.hostChanged();
    expect(await store.deleteSelected()).toBe(0);

    expect(store.selecting).toBe(false);
    expect(store.selected).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('re-saves the list backup without the deleted rows', async () => {
    const { store, saved } = harness();
    await store.load({ path: '/home/kai', name: 'kai' });
    saved.length = 0;
    store.startSelection(A);

    await store.deleteSelected();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.map((row) => row.path)).toEqual([B, C]);
  });

  it('a failed sweep leaves the backup alone', async () => {
    const { store, saved } = harness({ fail: A });
    await store.load({ path: '/home/kai', name: 'kai' });
    saved.length = 0;
    store.startSelection(A);

    await store.deleteSelected();

    // A is still on the host, so its backup stays truthful as it was.
    expect(saved).toEqual([]);
  });
});
