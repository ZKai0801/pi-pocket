// tests/unit/sessionsRecentCache.test.ts
/**
 * The 会话 tab's first screen (spec §8.5): the conversations recently opened on
 * this host, remembered by the store as it reads them. These tests pin what
 * lands in the recents (an opened conversation, a conversation whose first turn
 * was just delivered, and nothing at all on a failed open), the open-time
 * ordering (a background reply refreshes a row but never reorders the list,
 * while a pull-to-refresh of the open chat does not count as a new open), and
 * the host discipline (D8): a host switch drops the previous host's recents and
 * reads the new host's.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PiTurnBegun, PiTurnRunner, PiTurnSendResult } from '../../src/pi/piTurnRunner';
import type { RecentSessionEntry, RecentSessionMeta } from '../../src/pi/recentSessionsCache';
import type { ParsedPiSession } from '../../src/pi/types';
import { createSessionsStore } from '../../src/stores/sessions';

const A = '/root/a.jsonl';
const B = '/root/b.jsonl';

function session(id: string): ParsedPiSession {
  return {
    version: 3,
    id,
    cwd: '/home/kai/git/pocketshell',
    name: `session ${id}`,
    turns: [{ role: 'user', text: 'hello', timestampMs: 1 }],
  };
}

const SESSION_A = session('a');
const SESSION_B = session('b');
/** The same conversation once pi has answered: a fresh parse, one turn more. */
const ANSWERED_A: ParsedPiSession = {
  ...SESSION_A,
  turns: [...SESSION_A.turns, { role: 'assistant', text: 'done', timestampMs: 2 }],
};

function metaOf(parsed: ParsedPiSession, path: string): RecentSessionMeta {
  return {
    path,
    id: parsed.id ?? path,
    name: parsed.name,
    updatedAtMs: 1,
    preview: 'hello',
    turnCount: parsed.turns.length,
    projectPath: parsed.cwd,
  };
}

/**
 * A recents seam that behaves like the cache it stands in for: entries are kept
 * per host, listed most recently opened first, and a save decides open time by
 * the `reopened` flag the store passes — the one distinction the list's
 * ordering rests on.
 */
function recents() {
  const entries: RecentSessionEntry[] = [];
  let clock = 1_000;
  const byOpenTime = (left: RecentSessionEntry, right: RecentSessionEntry): number =>
    right.openedAtMs - left.openedAtMs;
  return {
    entries,
    load: vi.fn(async (host: string | null) =>
      host === null
        ? []
        : entries.filter((entry) => entry.host === host).sort(byOpenTime),
    ),
    save: vi.fn(async (host: string | null, meta: RecentSessionMeta, reopened: boolean) => {
      if (host === null) return;
      const existing = entries.find((entry) => entry.host === host && entry.path === meta.path);
      const openedAtMs = reopened || existing === undefined ? (clock += 1_000) : existing.openedAtMs;
      const kept = entries.filter((entry) => !(entry.host === host && entry.path === meta.path));
      entries.length = 0;
      entries.push(...kept, { host, ...meta, openedAtMs });
    }),
    ids: () => [...entries].sort(byOpenTime).map((entry) => entry.id),
  };
}

function storeWith(over: Record<string, unknown> = {}) {
  const seam = recents();
  const store = createSessionsStore({
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async (path: string) => (path === A ? SESSION_A : SESSION_B)),
    hostId: () => 'hetzner',
    loadRecentSessions: seam.load,
    rememberRecentSession: seam.save,
    ...over,
  } as never);
  return { store, seam };
}

function begun(sessionFile: string, completed: Promise<PiTurnSendResult>): PiTurnBegun {
  return { ok: true, sessionFile, completed };
}

/** Long enough for a delivered turn's fire-and-forget settlement to run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** A runner whose turn in `sessionFile` has already been answered. */
function answeredRunner(sessionFile: string): PiTurnRunner {
  return {
    send: vi.fn(async () => ({ ok: true as const, session: SESSION_A })),
    startNew: vi.fn(async () => ({
      ok: true as const,
      sessionFile: '/root/new.jsonl',
      session: SESSION_A,
    })),
    beginSend: vi.fn(async (path: string) =>
      begun(path, Promise.resolve({ ok: true as const, session: ANSWERED_A })),
    ),
    beginStartNew: vi.fn(async () =>
      begun('/root/new.jsonl', Promise.resolve({ ok: true as const, session: SESSION_A })),
    ),
    runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: false })),
    queue: vi.fn(async () => ({ ok: true as const })),
    rebind: vi.fn(),
    isBusy: vi.fn(() => false),
    dispose: vi.fn(),
  } satisfies PiTurnRunner;
}

describe('sessions store recents', () => {
  it('remembers a conversation when it is opened', async () => {
    const { store, seam } = storeWith();
    await store.openSession(A);
    expect(seam.ids()).toEqual(['a']);
    expect(seam.save).toHaveBeenCalledWith(
      'hetzner',
      expect.objectContaining({ path: A, id: 'a', projectPath: '/home/kai/git/pocketshell' }),
      true,
    );
  });

  it('reads the host\'s recents into the store', async () => {
    const { store, seam } = storeWith();
    await seam.save('hetzner', metaOf(SESSION_B, B), false);
    await seam.save('hetzner', metaOf(SESSION_A, A), false);
    await store.loadRecents();
    expect(store.recents.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('moves a re-opened conversation to the top, but not a pull-to-refresh', async () => {
    const { store, seam } = storeWith();
    await store.openSession(A);
    await store.openSession(B);
    expect(seam.ids()).toEqual(['b', 'a']);

    // The chat on screen re-reads itself: not a new open, the order stands.
    await store.refresh();
    expect(seam.ids()).toEqual(['b', 'a']);

    // Leaving and re-entering the conversation is a fresh open.
    store.closeChat();
    await store.openSession(A);
    expect(seam.ids()).toEqual(['a', 'b']);
  });

  it('refreshes a delivered reply\'s row without reordering the list', async () => {
    const { store, seam } = storeWith({ runner: answeredRunner(A) });
    await store.openSession(A);
    await expect(store.send('next please')).resolves.toBe('sent');
    await flush();
    await store.openSession(B);

    expect(seam.ids()).toEqual(['b', 'a']);
    const answered = seam.entries.find((entry) => entry.id === 'a');
    expect(answered?.turnCount).toBe(2);
    expect(answered?.updatedAtMs).toBe(2);
    // The refresh rides along as a save that is not a re-open: the entry keeps
    // the open time the conversation was opened with, not the reply's.
    expect(seam.save).toHaveBeenCalledWith(
      'hetzner',
      expect.objectContaining({ path: A, turnCount: 2 }),
      false,
    );
  });

  it('remembers a draft conversation once its first turn is delivered', async () => {
    const { store, seam } = storeWith({ runner: answeredRunner('/root/new.jsonl') });
    store.newConversation({ path: '/home/kai/git/pocketshell', name: 'pocketshell' });
    await expect(store.send('hello')).resolves.toBe('sent');
    await flush();
    expect(seam.ids()).toEqual(['a']);
    expect(seam.entries[0]?.path).toBe('/root/new.jsonl');
  });

  it('remembers nothing when the open fails', async () => {
    const { store, seam } = storeWith({
      readSession: vi.fn(async () => { throw new Error('exec 255'); }),
    });
    await store.openSession(A);
    expect(seam.ids()).toEqual([]);
  });

  it('drops the previous host\'s recents and reads the new host\'s', async () => {
    let host: string | null = 'hetzner';
    const { store, seam } = storeWith({ hostId: () => host });
    await seam.save('hetzner', metaOf(SESSION_A, A), false);
    await store.loadRecents();
    expect(store.recents.map((entry) => entry.id)).toEqual(['a']);

    host = 'other-box';
    store.hostChanged();
    expect(store.recents).toEqual([]);

    await seam.save('other-box', metaOf(SESSION_B, B), false);
    await store.loadRecents();
    expect(store.recents.map((entry) => entry.id)).toEqual(['b']);
    expect(seam.load).toHaveBeenLastCalledWith('other-box');
  });

  it('is silent when the recents cache cannot be read', async () => {
    const { store } = storeWith({
      loadRecentSessions: vi.fn(async () => { throw new Error('quota'); }),
    });
    await expect(store.loadRecents()).resolves.toBeUndefined();
    expect(store.recents).toEqual([]);
  });

  it('works exactly as before without the recents deps', async () => {
    const store = createSessionsStore({
      listSessions: vi.fn(async () => []),
      readSession: vi.fn(async () => SESSION_A),
    } as never);
    await store.openSession(A);
    await expect(store.loadRecents()).resolves.toBeUndefined();
    expect(store.recents).toEqual([]);
    expect(store.openPath).toBe(A);
  });
});
